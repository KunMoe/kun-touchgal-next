import { redirect } from 'next/navigation'
import { prisma } from '~/prisma/index'
import { getOidcProvider } from '~/lib/oidc/provider'
import { buildHeadersBridge } from '~/lib/oidc/webToNode'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { OIDC_MOUNT_PATH } from '~/config/oidc'
import { ConsentCard } from './ConsentCard'
import { ConfirmRedirect } from './ConfirmRedirect'
import { kunMetadata } from './metadata'
import type { Metadata } from 'next'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const metadata: Metadata = kunMetadata

interface Props {
  params: Promise<{ uid: string }>
}

export default async function OidcInteractionPage({ params }: Props) {
  const { uid } = await params
  const provider = getOidcProvider()
  const interactionPath = `${OIDC_MOUNT_PATH}/interaction/${uid}`
  const bridge = await buildHeadersBridge(interactionPath)

  let prompt: string
  let clientId = ''
  let scope = ''
  try {
    const details = await provider.interactionDetails(bridge.req, bridge.res)
    prompt = details.prompt.name
    clientId = String(details.params.client_id ?? '')
    scope = String(details.params.scope ?? '')
  } catch {
    return (
      <div className="mx-auto mt-20 max-w-md px-4 text-center">
        <p className="text-default-500">
          授权会话已失效或不存在，请重新发起登录。
        </p>
      </div>
    )
  }

  if (prompt === 'login') {
    const payload = await verifyHeaderCookie()
    if (!payload) {
      redirect(`/login?from=${encodeURIComponent(interactionPath)}`)
    }
    return <ConfirmRedirect confirmPath={`${interactionPath}/confirm`} />
  }

  if (prompt === 'consent') {
    const client = await prisma.oidc_client.findUnique({
      where: { client_id: clientId },
      select: { client_name: true }
    })
    const scopes = scope.split(' ').filter(Boolean)

    return (
      <ConsentCard
        clientName={client?.client_name ?? clientId}
        scopes={scopes}
        interactionPath={interactionPath}
      />
    )
  }

  return (
    <div className="mx-auto mt-20 max-w-md px-4 text-center">
      <p className="text-default-500">不支持的授权步骤：{prompt}</p>
    </div>
  )
}
