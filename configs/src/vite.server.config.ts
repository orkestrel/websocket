import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { srcServer, resolveWorkspacePath } from '../../vite.config'

export default defineConfig(
	srcServer({
		plugins: [
			dts({
				tsconfigPath: resolveWorkspacePath('configs/src/tsconfig.server.json'),
				bundleTypes: true,
			}),
		],
	}),
)
