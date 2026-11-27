import type {
  Control,
  FieldErrors,
  UseFormGetValues,
  UseFormSetValue,
  UseFormTrigger,
  UseFormWatch
} from 'react-hook-form'
import type { ResourceFormValues } from './form/linkDraft'

// 上传卡片展示的一个文件: 在等人机验证、正在传, 或者已经传完
export interface FileStatus {
  fileName: string
  size: string
  progress: number
  error?: string
  done: boolean
}

export type ErrorType = FieldErrors<ResourceFormValues>
export type ControlType = Control<ResourceFormValues, any>
export type GetValuesType = UseFormGetValues<ResourceFormValues>
export type SetValueType = UseFormSetValue<ResourceFormValues>
export type TriggerType = UseFormTrigger<ResourceFormValues>
export type WatchType = UseFormWatch<ResourceFormValues>
