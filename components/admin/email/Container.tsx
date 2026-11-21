'use client'

import { useState } from 'react'
import { CampaignProgress } from './CampaignProgress'
import { EmailTemplate } from './EmailTemplate'

export const EmailSetting = () => {
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">邮件群发</h1>
      </div>

      <CampaignProgress refreshKey={refreshKey} />

      <EmailTemplate onCreated={() => setRefreshKey((key) => key + 1)} />
    </div>
  )
}
