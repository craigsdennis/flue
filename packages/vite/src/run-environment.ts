/**
 * Public integration point for Vite-hosted `flue run` environments.
 *
 * A host plugin owns the platform emulator and the generated entry that Vite
 * serves. Its run environment receives one selected, registered agent and an
 * unpredictable localhost route prefix; it mounts Flue's normal conversation
 * protocol at that prefix. The CLI owns server startup, protocol driving, and
 * teardown.
 */
import type { Plugin } from 'vite';
import type { AgentScanResult } from './agent-scan.ts';

export interface FlueRunEnvironmentOptions {
	/** The registered agent selected from the module path and optional --name. */
	readonly agent: AgentScanResult;
	/** Random path prefix; mount the agent router below this exact prefix. */
	readonly routePrefix: string;
}

export interface FlueRunEnvironment {
	/** Short diagnostic name, e.g. `cloudflare` or `my-framework`. */
	readonly name: string;
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
