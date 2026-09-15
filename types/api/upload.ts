export interface KunUploadInitResponse {
  uploadUrl: string
  token: string
  expiresIn: number
}

export interface KunUploadCompleteResponse {
  filetype: 's3'
  fileToken: string
  fileSize: string
}
