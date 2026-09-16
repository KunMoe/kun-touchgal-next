'use client'

import { useState, useMemo, useEffect, useTransition } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { createCompanySchema, updateCompanySchema } from '~/validations/company'
import toast from 'react-hot-toast'
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  Textarea,
  ModalFooter,
  Select,
  SelectItem
} from '@heroui/react'
import { ArrayAdder } from './ArrayAdder'
import { SUPPORTED_LANGUAGE_MAP } from '~/constants/resource'
import { kunFetchPost, kunFetchPut } from '~/utils/kunFetch'
import { errorReporter, kunErrorHandlerAsync } from '~/utils/kunErrorHandler'
import type { Company, CompanyDetail } from '~/types/api/company'
import type { FC } from 'react'

type Condition<T, X, Y> = T extends 'create' ? X : Y

type createFormData = z.infer<typeof createCompanySchema>
type updateFormData = z.infer<typeof updateCompanySchema>
type FormData<T> = Condition<T, createFormData, updateFormData>

interface Props {
  type: 'create' | 'edit'
  isOpen: boolean
  onClose: () => void
  onSuccess: <T>(company: Condition<T, Company, CompanyDetail>) => void
  company?: CompanyDetail
}

const languages = Object.entries(SUPPORTED_LANGUAGE_MAP).map(
  ([key, value]) => ({ key, value })
)

export const CompanyFormModal: FC<Props> = ({
  type,
  isOpen,
  onClose,
  onSuccess,
  company
}) => {
  const isEdit = type === 'edit'

  const [aliasInput, setAliasInput] = useState('')
  const [websiteInput, setWebsiteInput] = useState('')
  const [brandInput, setBrandInput] = useState('')
  const [isSubmitting, startSubmit] = useTransition()

  const formDefaultValue = useMemo(() => {
    const defaultValue = {
      name: isEdit ? (company?.name ?? '') : '',
      introduction: isEdit ? (company?.introduction ?? '') : '',
      alias: isEdit ? (company?.alias ?? []) : [],
      primary_language: isEdit ? (company?.primary_language ?? []) : [],
      official_website: isEdit ? (company?.official_website ?? []) : [],
      parent_brand: isEdit ? (company?.parent_brand ?? []) : []
    } as FormData<typeof type>

    if (isEdit && company) {
      ;(defaultValue as updateFormData).companyId = company.id
    }

    return defaultValue
  }, [isEdit, company])

  const {
    register,
    formState: { errors },
    getValues,
    watch,
    setValue,
    reset
  } = useForm<FormData<typeof type>>({
    resolver: zodResolver(isEdit ? updateCompanySchema : createCompanySchema),
    defaultValues: formDefaultValue
  })

  useEffect(() => {
    if (isEdit && isOpen) {
      reset({
        companyId: company?.id ?? 0,
        name: company?.name ?? '',
        introduction: company?.introduction ?? '',
        alias: company?.alias ?? [],
        primary_language: company?.primary_language ?? [],
        official_website: company?.official_website ?? [],
        parent_brand: company?.parent_brand ?? []
      })
    }
  }, [isOpen, company, reset, isEdit])

  const addAlias = () => {
    const lowerCompany = aliasInput.trim().toLowerCase()
    if (!lowerCompany) {
      return
    }

    const prevAlias = getValues().alias
    if (!prevAlias?.includes(lowerCompany)) {
      setValue('alias', [...prevAlias, lowerCompany])
      setAliasInput('')
    } else {
      toast.error('该会社别名已存在，请更换')
    }
  }

  const handleRemoveAlias = (index: number) => {
    const prevAlias = getValues().alias
    setValue(
      'alias',
      prevAlias?.filter((_, i) => i !== index)
    )
  }

  const addWebsite = () => {
    const trimmedWebsite = websiteInput.trim()
    if (!trimmedWebsite) {
      return
    }

    const prevWebsite = getValues().official_website
    if (!prevWebsite?.includes(trimmedWebsite)) {
      setValue('official_website', [...prevWebsite, trimmedWebsite])
      setWebsiteInput('')
    } else {
      toast.error('该站点地址已存在，请更换')
    }
  }

  const handleRemoveWebsite = (index: number) => {
    const prevWebsite = getValues().official_website
    setValue(
      'official_website',
      prevWebsite?.filter((_, i) => i !== index)
    )
  }

  const addParentBrand = () => {
    const lowerBrand = brandInput.trim().toLowerCase()
    if (!lowerBrand) {
      return
    }

    const prevBrand = getValues().parent_brand
    if (!prevBrand?.includes(lowerBrand)) {
      setValue('parent_brand', [...prevBrand, lowerBrand])
      setBrandInput('')
    } else {
      toast.error('该母公司已存在，请更换')
    }
  }

  const handleRemoveParentBrand = (index: number) => {
    const prevBrand = getValues().parent_brand
    setValue(
      'parent_brand',
      prevBrand?.filter((_, i) => i !== index)
    )
  }

  const updateCompany = async (
    companyId: number
  ): Promise<KunResponse<CompanyDetail>> => {
    const res = await kunFetchPut<KunResponse<CompanyDetail>>('/company', {
      ...watch(),
      companyId
    })
    return res
  }

  const createCompany = async (): Promise<KunResponse<Company>> => {
    const res = await kunFetchPost<KunResponse<Company>>('/company', watch())
    return res
  }

  const handleSubmit = () => {
    startSubmit(async () => {
      try {
        if (isEdit) {
          const companyId = company!.id
          const res = await updateCompany(companyId)
          const result = await kunErrorHandlerAsync(res)

          toast.success('会社信息更新成功')
          onSuccess<typeof type>(result)
          reset()
        } else {
          const res = await createCompany()
          const result = await kunErrorHandlerAsync(res)

          toast.success('会社创建成功')
          onSuccess<typeof type>(result)
          reset()
        }
      } catch (err) {
        errorReporter(err)
      }
    })
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  return (
    <Modal
      size="2xl"
      isOpen={isOpen}
      onClose={handleClose}
      isDismissable={false}
      isKeyboardDismissDisabled={true}
    >
      <ModalContent>
        <form>
          <ModalHeader>{isEdit ? '编辑会社信息' : '创建新会社'}</ModalHeader>
          <ModalBody>
            <div className="space-y-6">
              <Input
                {...register('name')}
                label="会社名"
                placeholder="输入会社名"
                isInvalid={!!errors.name}
                errorMessage={errors.name?.message}
              />

              <Select
                label="主要语言"
                placeholder="请选择主要语言"
                selectionMode="multiple"
                defaultSelectedKeys={formDefaultValue.primary_language}
                onSelectionChange={(key) => {
                  setValue('primary_language', [...key] as string[])
                }}
                isInvalid={!!errors.primary_language}
                errorMessage={errors.primary_language?.message}
              >
                {languages.map((language) => (
                  <SelectItem key={language.key}>{language.value}</SelectItem>
                ))}
              </Select>

              <Textarea
                {...register('introduction')}
                label="会社简介"
                placeholder="输入会社简介"
                isInvalid={!!errors.introduction}
                errorMessage={errors.introduction?.message}
              />

              <ArrayAdder
                label="别名"
                placeholder="可以按回车添加别名"
                input={aliasInput}
                setInput={setAliasInput}
                addItem={addAlias}
                removeItem={handleRemoveAlias}
                dataSource={watch().alias}
              />

              <ArrayAdder
                label="官网站点"
                placeholder="可以按回车添加官网站点"
                input={websiteInput}
                setInput={setWebsiteInput}
                addItem={addWebsite}
                removeItem={handleRemoveWebsite}
                dataSource={watch().official_website}
              />

              <ArrayAdder
                label="母公司"
                placeholder="可以按回车添加母公司"
                input={brandInput}
                setInput={setBrandInput}
                addItem={addParentBrand}
                removeItem={handleRemoveParentBrand}
                dataSource={watch().parent_brand}
              />
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={handleClose}>
              取消
            </Button>
            <Button
              color="primary"
              isDisabled={isSubmitting}
              isLoading={isSubmitting}
              onPress={handleSubmit}
            >
              {isEdit ? '保存' : '创建'}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  )
}
