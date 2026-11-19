'use client'

import { useState, useEffect, useTransition } from 'react'
import { useDebounce } from 'use-debounce'
import { KunPagination } from '~/components/kun/Pagination'
import { CompanyHeader } from './CompanyHeader'
import { SearchCompanies } from './SearchCompanies'
import { CompanyList } from './CompanyList'
import { useMounted } from '~/hooks/useMounted'
import { kunFetchGet, kunFetchPost } from '~/utils/kunFetch'
import { errorReporter, kunErrorHandler } from '~/utils/kunErrorHandler'
import type { FC } from 'react'
import type { Company as CompanyType } from '~/types/api/company'

const MAX_COMPANY_SEARCH_KEYWORDS = 10

interface Props {
  initialCompanies: CompanyType[]
  initialTotal: number
}

export const Container: FC<Props> = ({ initialCompanies, initialTotal }) => {
  const [companies, setCompanies] = useState<CompanyType[]>(initialCompanies)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(initialTotal)
  const [loading, startTransition] = useTransition()
  const isMounted = useMounted()

  const fetchCompanies = () => {
    startTransition(async () => {
      const response = await kunFetchGet<{
        companies: CompanyType[]
        total: number
      }>('/company/all', {
        page,
        limit: 100
      })
      kunErrorHandler(response, (value) => {
        setCompanies(value.companies)
        setTotal(value.total)
      })
    })
  }

  useEffect(() => {
    if (!isMounted) {
      return
    }
    fetchCompanies()
  }, [page])

  const [query, setQuery] = useState('')
  const [debouncedQuery] = useDebounce(query, 500)
  const [searching, setSearching] = useState(false)

  const handleSearch = async (searchQuery = query) => {
    const searchTerms = searchQuery
      .trim()
      .split(/\s+/u, MAX_COMPANY_SEARCH_KEYWORDS + 1)
      .filter(Boolean)
    if (searchTerms.length === 0) {
      return
    }

    if (searchTerms.length > MAX_COMPANY_SEARCH_KEYWORDS) {
      kunErrorHandler('您最多使用 10 组关键词', () => {})
      return
    }

    setSearching(true)
    try {
      const res = await kunFetchPost<CompanyType[] | string>(
        '/company/search',
        {
          query: searchTerms
        }
      )

      if (typeof res === 'string') {
        kunErrorHandler(res, () => {})
        return
      }

      setCompanies(res)
    } catch (error) {
      errorReporter(error)
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    if (!isMounted) {
      return
    }

    if (debouncedQuery.trim()) {
      handleSearch(debouncedQuery)
    } else {
      fetchCompanies()
    }
  }, [debouncedQuery])

  return (
    <div className="flex flex-col w-full my-4 space-y-8">
      <CompanyHeader
        setNewCompany={(company) => setCompanies([company, ...companies])}
      />

      <SearchCompanies
        query={query}
        setQuery={setQuery}
        handleSearch={handleSearch}
        searching={searching}
      />

      {!searching && (
        <CompanyList
          companies={companies}
          loading={loading}
          searching={searching}
        />
      )}

      {total > 100 && !query.trim() && (
        <div className="flex justify-center">
          <KunPagination
            total={Math.ceil(total / 100)}
            page={page}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  )
}
