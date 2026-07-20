import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from 'firebase/firestore'
import { FileText, Plus, Trash2 } from 'lucide-react'
import { db } from '../lib/firebase'
import { useAuth } from '../lib/AuthContext'
import PageHeader from '../components/PageHeader'
import { Badge, Button, EmptyState, Select } from '../components/ui'
import {
  CATEGORIES,
  CATEGORY_LABELS,
  LANGUAGES,
  type Category,
} from '../constants'
import type { PressRelease } from '../types'
import { blankVersions, formatDate } from '../lib/helpers'

export default function PressListPage() {
  const [items, setItems] = useState<PressRelease[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Category | 'all'>('all')
  const navigate = useNavigate()
  const { appUser } = useAuth()

  useEffect(() => {
    const q = query(collection(db, 'pressReleases'), orderBy('updatedAt', 'desc'))
    return onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PressRelease))
      setLoading(false)
    })
  }, [])

  const visible = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.category === filter)),
    [items, filter],
  )

  async function createDraft() {
    const ref = await addDoc(collection(db, 'pressReleases'), {
      title: '未命名新聞稿',
      category: 'brand' satisfies Category,
      versions: blankVersions(),
      attachments: [],
      status: 'draft',
      createdBy: appUser?.email ?? '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    navigate(`/press/${ref.id}`)
  }

  async function remove(e: React.MouseEvent, item: PressRelease) {
    e.stopPropagation()
    if (!confirm(`確定要刪除「${item.title}」嗎？`)) return
    await deleteDoc(doc(db, 'pressReleases', item.id))
  }

  return (
    <>
      <PageHeader
        title="新聞稿"
        description="每篇稿件包含 tw / www / us 三個語言版本。"
        actions={
          <Button variant="primary" onClick={createDraft}>
            <Plus className="size-4" />
            新增新聞稿
          </Button>
        }
      />

      <div className="p-8">
        <div className="mb-5 w-48">
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as Category | 'all')}
          >
            <option value="all">全部分類</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </div>

        {loading ? (
          <p className="py-16 text-center text-sm text-slate-400">載入中…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            title="還沒有新聞稿"
            description="建立第一篇稿件，填好三個語言版本後即可發送。"
            action={
              <Button variant="primary" onClick={createDraft}>
                <Plus className="size-4" />
                新增新聞稿
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3">
            {visible.map((item) => {
              const filled = LANGUAGES.filter(
                (l) => item.versions?.[l]?.subject?.trim(),
              ).length
              return (
                <div
                  key={item.id}
                  onClick={() => navigate(`/press/${item.id}`)}
                  className="flex cursor-pointer items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand-200 hover:shadow-sm"
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                    <FileText className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-slate-900">
                      {item.title}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                      <Badge>{CATEGORY_LABELS[item.category]}</Badge>
                      <span>已填 {filled}/3 個語言版本</span>
                      <span>·</span>
                      <span>更新於 {formatDate(item.updatedAt)}</span>
                    </div>
                  </div>
                  <Badge tone={item.status === 'sent' ? 'green' : 'amber'}>
                    {item.status === 'sent' ? '已發送' : '草稿'}
                  </Badge>
                  <button
                    onClick={(e) => remove(e, item)}
                    title="刪除"
                    className="rounded-lg p-2 text-slate-300 transition hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
