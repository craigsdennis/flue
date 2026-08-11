/**
 * Public integration point for Vite-hosted `flue run` environments.
 *
 * A host plugin owns the platform emulator and the generated entry that Vite
 * serves. Its run environment receives one selected, registered agent and an
 * unpredictable localhost route prefix; it mounts Flue's normal conversation
 * protocol at that prefix. The CLI owns server startup, protocol driving, and
 * teardown.
 */
import type { Plugin, PluginOption } from 'vite';
import type { AgentScanResult } from './agent-scan.ts';

export interface FlueRunEnvironmentOptions {
	/** The registered agent selected from the module path and optional --name. */
	readonly agent: AgentScanResult;
	/** Random path prefix; mount the agent router below this exact prefix. */
	readonly routePrefix: string;
}

export interface FlueRunEnvironmentDetectionContext {
	/** The flattened plugin set from the evaluated Vite config. */
	readonly plugins: readonly Plugin[];
}

export interface FlueRunEnvironment {
	/** Short diagnostic name, e.g. `cloudflare` or `my-framework`. */
	readonly name: string;
	/**
	 * Whether an unflagged `flue run` should select this environment. Defaults
	 * to true. A predicate lets a bundled integration claim the run only when
	 * its owning sibling plugin is present.
	 */
	readonly auto?:
		| boolean
		| ((context: FlueRunEnvironmentDetectionContext) => boolean | Promise<boolean>);
	/**
	 * Prepare the host's dev entry to serve the selected agent at routePrefix.
	 * Called after normal Vite config resolution and before the server listens.
	 */
	configure(options: FlueRunEnvironmentOptions): void | Promise<void>;
}

interface FlueRunEnvironmentRegistrar {
	registerRunEnvironment(environment: FlueRunEnvironment): void;
}

/**
 * Register a Vite host as a `flue run --vite` environment. Add this after
 * `flue()` in the user's Vite plugin array. The host's own plugin normally
 * creates the descriptor and closes over whatever entry-generation state its
 * `configure` callback needs to mutate.
 */
export function flueRunEnvironment(environment: FlueRunEnvironment): Plugin {
	if (typeof environment.name !== 'string' || environment.name.trim() === '') {
		throw new Error('[flue] A Vite run environment requires a non-empty name.');
	}
	if (typeof environment.configure !== 'function') {
		throw new Error(
			`[flue] Vite run environment ${JSON.stringify(environment.name)} requires a configure() function.`,
		);
	}

	return {
		name: `flue-run-environment:${environment.name}`,
		apply: 'serve',
		api: runEnvironmentPluginApi(environment),
		configResolved(config) {
			const core = config.plugins.find((plugin) => plugin.name === 'flue');
			const api = core?.api as FlueRunEnvironmentRegistrar | undefined;
			if (!api || typeof api.registerRunEnvironment !== 'function') {
				throw new Error(
					`[flue] Vite run environment ${JSON.stringify(environment.name)} could not find flue(). ` +
						'Add flue() before flueRunEnvironment() in the Vite plugins array.',
				);
			}
			api.registerRunEnvironment(environment);
		},
	};
}

interface FlueRunEnvironmentPluginApi {
	readonly flueRunEnvironment: {
		readonly version: 1;
		readonly environment: FlueRunEnvironment;
	};
}

/** Marker attached synchronously so the CLI can inspect a loaded Vite config without running hooks. */
export function runEnvironmentPluginApi(
	environment: FlueRunEnvironment,
): FlueRunEnvironmentPluginApi {
	return { flueRunEnvironment: { version: 1, environment } };
}

/** Find environments declared by an evaluated Vite config's plugin options. */
export async function detectAutoRunEnvironments(
	pluginOptions: readonly PluginOption[],
): Promise<FlueRunEnvironment[]> {
	const plugins = await flattenPluginOptions(pluginOptions);
	const detected: FlueRunEnvironment[] = [];
	for (const plugin of plugins) {
		const marker = (plugin.api as Partial<FlueRunEnvironmentPluginApi> | undefined)
			?.flueRunEnvironment;
		if (marker?.version !== 1 || !marker.environment) continue;
		const { environment } = marker;
		const automatic =
			typeof environment.auto === 'function'
				? await environment.auto({ plugins })
				: environment.auto !== false;
		if (automatic) detected.push(environment);
	}
	return detected;
}

async function flattenPluginOptions(options: readonly PluginOption[]): Promise<Plugin[]> {
	const plugins: Plugin[] = [];
	const visit = async (option: PluginOption): Promise<void> => {
		const resolved = await option;
		if (!resolved) return;
		if (Array.isArray(resolved)) {
			for (const nested of resolved) await visit(nested);
			return;
		}
		plugins.push(resolved);
	};
	for (const option of options) await visit(option);
	return plugins;
}
