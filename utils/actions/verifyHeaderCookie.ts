import 'server-only'
import { getViewerContext } from '~/server/viewer/fromHeaders'

export const verifyHeaderCookie = async () =>
  (await getViewerContext()).viewer()
