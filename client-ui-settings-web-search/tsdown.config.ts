import { clientBundle } from '../../packages/client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'])
