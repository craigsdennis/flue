/**
 * `flue run <path>` — one-shot local agent execution.
 *
 * Node runs remain transport-free: the CLI spins up a NON-LISTENING Vite
 * module server and hands execution to run-bootstrap.ts inside the user's
 * single-runtime graph. A Vite-hosted run instead starts the user's Vite
 * environment on an OS-assigned localhost port, adds an ephemeral private
 * route for the selected agent, and drives the normal conversation protocol.
 * Every Vite host opts in with --vite through the public
 * flueRunEnvironment() integration point.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import {
	type FlueConfig,
	loadFlueConfigModule,
	parseFlueConfig,
	resolveFlueConfigPath,
	resolveFlueProject,
} from '@flue/runtime/config';
import { createFlueClient, FlueExecutionError } from '@flue/sdk';
import {
	createImportTrace,
	findCloudflareSpecifier,
	flueDependencyResolverPlugin,
	type ImportTrace,
	markdownImportPlugin,
	runBridgePlugin,
	scanAgentModuleCode,
} from '@flue/vite/internal';
import { ulid } from 'ulidx';
import { UsageError } from '../errors.ts';
import type { FlueRunOutcome, FlueRunSession, FlueRunSessionOptions } from './run-bootstrap.ts';

interface LocalAgentRunReadyInfo {
	identity: string;
	conversationId: string;
	root: string;
	configPath: string | undefined;
	/** The db entry module path when one resolved, else the default cache db file. */
	dbEntry: string | undefined;
	dbPath: string | undefined;
	/** Present only when a Vite host owns the run. */
	environment?: string;
}

export interface LocalAgentRunOptions {
	/** The `<path>` argument as the user typed it. */
	modulePath: string;
	/** Which agent to run, by name, when the module defines several (--name). */
	agentName?: string;
	message: string;
	/** Instance-creation data; the seed, consulted only when this send creates. */
	initialData?: unknown;
	/**
	 * Send condition: a string continues only the incarnation with that uid;
	 * `null` creates only when no instance exists; omit for unconditional.
	 */
	uid?: string | null;
	/** Caller-chosen conversation id; a fresh ulid is minted when absent. */
	conversationId?: string;
	/** Force the project-registered Vite run environment (--vite). */
	vite?: boolean;
	cwd?: string;
	onEvent?: (chunk: unknown) => void;
	/** Captured runtime/module console output (routed to stderr by the caller). */
	onRuntimeOutput?: (line: string) => void;
	/** Fires after the module graph loads, before the message is submitted. */
	onReady?: (info: LocalAgentRunReadyInfo) => void;
}

interface LocalAgentRunResult extends FlueRunOutcome {
	identity: string;
	conversationId: string;
}

export interface LocalAgentRun {
	readonly signal: AbortSignal;
	start(): Promise<LocalAgentRunResult>;
	/** Request an abort: the run drains to its aborted settlement. */
	cancel(reason?: unknown): void;
	/** Deterministic teardown: coordinator, adapter, instrumentation, Vite. */
	close(): Promise<void>;
	forceCloseSync(): void;
}

const RUN_DB_RELATIVE_PATH = path.join('node_modules', '.cache', 'flue', 'run.db');

/** Config fields `flue run` honors; anything else (legacy `root`/`output`, …) is ignored. */
const RUN_CONFIG_FIELDS = ['target', 'app', 'db', 'cloudflare', 'agents'] as const;

export function createLocalAgentRun(options: LocalAgentRunOptions): LocalAgentRun {
	const controller = new AbortController();
	let viteServer: ViteDevServerLike | undefined;
	let session: FlueRunSession | undefined;
	let started: Promise<LocalAgentRunResult> | undefined;
	let closePromise: Promise<void> | undefined;

	const closeResources = async (): Promise<void> => {
		const errors: unknown[] = [];
		try {
			await session?.close();
		} catch (error) {
			errors.push(error);
		} finally {
			session = undefined;
		}
		try {
			await viteServer?.close();
		} catch (error) {
			errors.push(error);
		} finally {
			viteServer = undefined;
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, '[flue] flue run teardown failed.');
	};

	return {
		signal: controller.signal,
		start() {
			started ??= start();
			return started;
		},
		cancel(reason = new DOMException('Aborted', 'AbortError')) {
			controller.abort(reason);
		},
		close() {
			closePromise ??= (async () => {
				await started?.catch(() => undefined);
				await closeResources();
			})();
			return closePromise;
		},
		forceCloseSync() {
			controller.abort(new DOMException('Aborted', 'AbortError'));
			// Best-effort: the process is about to exit; kick teardown off
			// without awaiting so file handles at least begin closing.
			void closeResources().catch(() => undefined);
		},
	};

	async function start(): Promise<LocalAgentRunResult> {
		const cwd = options.cwd ?? process.cwd();
		const agentPath = resolveAgentModule(cwd, options.modulePath);
		// The build scanner's export-shape rule decides what counts as an agent
		// (classes and factory-made functions never do), so `flue run` and
		// `vite dev`/build can never disagree about a module's agents. The module
		// is named by explicit path, so the directive is not required.
		const agentScan = await scanAgentModuleCode(fs.readFileSync(agentPath, 'utf8'), agentPath, {
			requireDirective: false,
		});
		const conversationId = options.conversationId ?? ulid();

		const { configPath, project } = await resolveRunProject(cwd);
		if (options.vite === true) {
			const restoreConsole = redirectStdoutConsole(options.onRuntimeOutput);
			try {
				return await startViteRun({
					project,
					configPath,
					agentPath,
					conversationId,
					controller,
					setServer: (server) => {
						viteServer = server;
					},
				});
			} finally {
				restoreConsole();
			}
		}

		const defaultSqlitePath = path.join(project.root, RUN_DB_RELATIVE_PATH);
		if (project.db === undefined) {
			fs.mkdirSync(path.dirname(defaultSqlitePath), { recursive: true });
		}

		throwIfAborted(controller.signal);
		const importTrace = createImportTrace({ enabled: () => true });
		viteServer = await createRunModuleServer(project.root, importTrace);
		const server = viteServer;
		const loadContext: RunModuleLoadContext = { cwd, root: project.root, importTrace };

		const restoreConsole = redirectStdoutConsole(options.onRuntimeOutput);
		try {
			const bootstrap = (await loadRunModule(
				server,
				resolveBootstrapModulePath(),
				loadContext,
			)) as {
				createFlueRunSession(sessionOptions: FlueRunSessionOptions): Promise<FlueRunSession>;
			};
			throwIfAborted(controller.signal);
			session = await bootstrap.createFlueRunSession({
				agentModulePath: agentPath,
				agentExports: agentScan.agents.map((agent) => agent.exportName),
				...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
				...(project.db !== undefined
					? {
							dbModulePath: project.db,
							dbSource: displayPath(project.root, project.db),
						}
					: {}),
				defaultSqlitePath,
				env: process.env,
				loadModule: (modulePath) => loadRunModule(server, modulePath, loadContext),
			});
			throwIfAborted(controller.signal);
			const resolvedIdentity = session.identity;

			options.onReady?.({
				identity: resolvedIdentity,
				conversationId,
				root: project.root,
				configPath,
				dbEntry: project.db !== undefined ? displayPath(project.root, project.db) : undefined,
				dbPath: project.db === undefined ? displayPath(project.root, defaultSqlitePath) : undefined,
			});

			const outcome = await session.submit(
				conversationId,
				{ kind: 'user', body: options.message },
				{
					signal: controller.signal,
					initialData: options.initialData,
					uid: options.uid,
					onEvent: (chunk) => options.onEvent?.(chunk),
				},
			);
			return { ...outcome, identity: resolvedIdentity, conversationId };
		} finally {
			restoreConsole();
		}
	}

	async function startViteRun(args: {
		project: ReturnType<typeof resolveFlueProject>;
		configPath: string | undefined;
		agentPath: string;
		conversationId: string;
		controller: AbortController;
		setServer(server: ListeningViteDevServerLike): void;
	}): Promise<LocalAgentRunResult> {
		throwIfAborted(args.controller.signal);
		const routePrefix = `/__flue/run/${randomUUID()}`;
		let identity: string | undefined;
		let environment: string | undefined;
		const server = await createViteRunServer({
			root: args.project.root,
			agentModulePath: args.agentPath,
			agentName: options.agentName,
			routePrefix,
			onReady: (selected) => {
				identity = selected.identity;
				environment = selected.environment;
			},
		});
		args.setServer(server);
		await server.listen();
		throwIfAborted(args.controller.signal);
		if (!identity || !environment) {
			throw new Error('[flue] Internal error: the Vite run environment was not configured.');
		}

		const address = server.httpServer?.address();
		if (!address || typeof address === 'string') {
			throw new Error('[flue] Internal error: the Cloudflare development server did not listen.');
		}
		const client = createFlueClient({
			url: `http://127.0.0.1:${address.port}${routePrefix}/${encodeURIComponent(args.conversationId)}`,
		});

		options.onReady?.({
			identity,
			conversationId: args.conversationId,
			root: args.project.root,
			configPath: args.configPath,
			dbEntry: undefined,
			dbPath: undefined,
			environment,
		});

		const admission = await client.send({
			message: { kind: 'user', body: options.message },
			...(options.initialData !== undefined ? { initialData: options.initialData } : {}),
			...(options.uid !== undefined ? { uid: options.uid } : {}),
		});

		let abortRequested = false;
		const requestAbort = () => {
			if (abortRequested) return;
			abortRequested = true;
			void client.abort().catch((error) => {
				console.error('[flue] Abort request failed:', error);
			});
		};
		if (args.controller.signal.aborted) requestAbort();
		args.controller.signal.addEventListener('abort', requestAbort, { once: true });

		try {
			const reply = await client.read(admission, {
				onEvent: (chunk) => options.onEvent?.(chunk),
			});
			return {
				identity,
				conversationId: args.conversationId,
				submissionId: admission.submissionId,
				outcome: 'completed',
				message: reply.text,
				uid: admission.uid,
			};
		} catch (error) {
			if (
				error instanceof FlueExecutionError &&
				(error.failure === 'failed' || error.failure === 'aborted')
			) {
				return {
					identity,
					conversationId: args.conversationId,
					submissionId: admission.submissionId,
					outcome: error.failure,
					error: error.error,
					message: '',
					uid: admission.uid,
				};
			}
			throw error;
		} finally {
			args.controller.signal.removeEventListener('abort', requestAbort);
		}
	}
}

// ─── Module-path resolution ─────────────────────────────────────────────────

function resolveAgentModule(cwd: string, rawPath: string): string {
	const absolute = path.resolve(cwd, rawPath);
	const exists = fs.existsSync(absolute) && fs.statSync(absolute).isFile();
	if (!exists) {
		if (!looksLikeModulePath(rawPath)) {
			throw new UsageError(
				`\`flue run\` takes a module path, not a name. ` +
					`Pass the path of a module that exports an agent function, ` +
					`e.g. \`flue run src/agents/${rawPath}.ts --message "..."\`.`,
			);
		}
		throw new UsageError(`Agent module not found: ${rawPath}`);
	}
	return absolute;
}

function looksLikeModulePath(value: string): boolean {
	return (
		value.includes('/') ||
		value.includes('\\') ||
		value.startsWith('.') ||
		path.isAbsolute(value) ||
		/\.[cm]?[jt]sx?$/i.test(value)
	);
}

// ─── Project config ─────────────────────────────────────────────────────────

/**
 * Load `flue.config.*` honoring the NEW schema (`target`/`app`/`db`/
 * `cloudflare`/`agents`). Legacy fields (`root`, `output`) and unknown keys
 * are dropped before validation so old config files keep working under
 * `flue run`, which only needs source-root/db resolution.
 */
async function resolveRunProject(cwd: string): Promise<{
	configPath: string | undefined;
	project: ReturnType<typeof resolveFlueProject>;
}> {
	const configPath = resolveFlueConfigPath({ cwd });
	let config: FlueConfig = {};
	if (configPath) {
		const configModule = await loadFlueConfigModule(configPath);
		const raw = configModule.default;
		if (raw == null || typeof raw !== 'object') {
			throw new Error(
				`[flue] ${path.basename(configPath)} must export a config object as the default export.`,
			);
		}
		const picked: Record<string, unknown> = {};
		for (const field of RUN_CONFIG_FIELDS) {
			const value = (raw as Record<string, unknown>)[field];
			if (value !== undefined) picked[field] = value;
		}
		config = parseFlueConfig(picked, path.basename(configPath));
	}
	const project = resolveFlueProject({
		root: cwd,
		config,
		...(configPath !== undefined ? { configPath } : {}),
	});
	return { configPath, project };
}

// ─── Module loading (non-listening Vite server) ─────────────────────────────

interface ViteDevServerLike {
	ssrLoadModule(url: string): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}

interface ListeningViteDevServerLike extends ViteDevServerLike {
	listen(): Promise<unknown>;
	httpServer: {
		address(): string | { port: number } | null;
	} | null;
}

async function createViteRunServer(options: {
	root: string;
	agentModulePath: string;
	agentName: string | undefined;
	routePrefix: string;
	onReady(info: { identity: string; environment: string }): void;
}): Promise<ListeningViteDevServerLike> {
	const { createServer } = await import('vite');
	return (await createServer({
		root: options.root,
		logLevel: 'silent',
		clearScreen: false,
		server: {
			host: '127.0.0.1',
			// An OS-assigned port makes concurrent runs safe and never collides
			// with an already-running project dev server.
			port: 0,
			strictPort: true,
			open: false,
		},
		plugins: [
			runBridgePlugin({
				agentModulePath: options.agentModulePath,
				...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
				routePrefix: options.routePrefix,
				onReady: ({ identity, environment }) => options.onReady({ identity, environment }),
			}),
		],
	})) as ListeningViteDevServerLike;
}

/**
 * Non-listening module server: middleware mode with hmr disabled binds no
 * port and starts no websocket. The dependency resolver keeps exactly ONE
 * copy of `@flue/runtime` in the graph (externalized to the project's
 * install); `@earendil-works/pi-ai` is forced external for the same
 * module-scoped-registry reason (Vite would otherwise inline a symlinked
 * copy, splitting the provider registry the runtime shares with it).
 */
async function createRunModuleServer(
	root: string,
	importTrace: ImportTrace,
): Promise<ViteDevServerLike> {
	const { createServer } = await import('vite');
	return await createServer({
		configFile: false,
		root,
		appType: 'custom',
		logLevel: 'silent',
		resolve: { preserveSymlinks: true },
		optimizeDeps: { noDiscovery: true, include: [] },
		ssr: { external: ['@earendil-works/pi-ai'] },
		server: {
			middlewareMode: true,
			hmr: false,
			// Without this Vite still creates a standalone HMR websocket server
			// (default port 24678) even when `hmr` is false — `flue run` must
			// never bind a port.
			ws: false,
			watch: null,
		},
		plugins: [
			markdownImportPlugin(),
			importTrace.plugin,
			flueDependencyResolverPlugin({ root, external: true, importers: [] }),
		],
	});
}

interface RunModuleLoadContext {
	cwd: string;
	root: string;
	importTrace: ImportTrace;
}

async function loadRunModule(
	server: ViteDevServerLike,
	modulePath: string,
	context: RunModuleLoadContext,
): Promise<Record<string, unknown>> {
	try {
		return await server.ssrLoadModule(modulePath);
	} catch (error) {
		const specifier = findCloudflareSpecifier(error);
		if (specifier !== undefined) {
			const chain = context.importTrace.explain(specifier, context.root);
			throw new Error(
				`[flue] Failed to load ${displayPath(context.cwd, modulePath)}: it (or a module it imports) ` +
					`depends on '${specifier}'. \`flue run\` is Node-local; ` +
					`platform behavior belongs to \`vite dev\`. If the import is only used for types, ` +
					`change it to \`import type\` so it is erased at build time.` +
					(chain ? `\n\nImport chain:\n${chain}` : ''),
				{ cause: error },
			);
		}
		throw error;
	}
}

/**
 * Locate the bootstrap module for `ssrLoadModule`. In the published/built
 * CLI this file is bundled into `dist/flue.js`, and the bootstrap ships as
 * the sibling `dist/run-bootstrap.mjs` build entry; when running from
 * source it sits next to this file as `run-bootstrap.ts`.
 */
function resolveBootstrapModulePath(): string {
	for (const candidate of ['./run-bootstrap.mjs', './run-bootstrap.ts']) {
		const candidatePath = fileURLToPath(new URL(candidate, import.meta.url));
		if (fs.existsSync(candidatePath)) return candidatePath;
	}
	throw new Error('[flue] Internal error: the flue run bootstrap module is missing.');
}

// ─── Console redirection ────────────────────────────────────────────────────

/**
 * `flue run` reserves stdout for the final message (pipeable output), so
 * stdout-bound console methods are rerouted for the duration of the run —
 * agent/module `console.log` output surfaces on stderr via the caller.
 * `console.warn`/`console.error` already write to stderr and pass through.
 */
function redirectStdoutConsole(onLine: ((line: string) => void) | undefined): () => void {
	if (!onLine) return () => {};
	const methods = ['log', 'info', 'debug'] as const;
	const originals = new Map<(typeof methods)[number], (...args: unknown[]) => void>();
	for (const method of methods) {
		const original = console[method] as (...args: unknown[]) => void;
		originals.set(method, original);
		console[method] = (...args: unknown[]) => {
			onLine(format(...args));
		};
	}
	return () => {
		for (const [method, original] of originals) console[method] = original;
	};
}

function displayPath(root: string, filePath: string): string {
	const relative = path.relative(root, filePath);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
