/** Package build entry: delegates to the shared dual-face build tool. */
import { buildPlugin } from '../../tools/build-plugin.mjs'

await buildPlugin({ pluginName: 'dsh-tavern' })
