import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema',
  datasource: {
    url: env('KUN_DATABASE_URL')
  }
})
