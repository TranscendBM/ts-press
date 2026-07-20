import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import {
  Archive,
  ArchiveRestore,
  FileText,
  Plus,
  Trash2,
} from 'lucide-react'
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
import { blankVersions, formatDate, todayIso } from '../lib/helpers'

export default function PressListPage() {
  const [items, setItems] = useState<PressRelease[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState<Category | 'all'>('all')
  const [year, setYear] = useState<string>('all')
  const navigate = useNavigate()
  const { appUser } = useAuth()

  useEffect(() => {
    // 不用 orderBy：舊資料可能缺 updatedAt，會被查詢排除掉
    return onSnapshot(collection(db, 'pressReleases'), (snap) => {
      const rows = snap.docs.map(
        (d) => ({ id: d.id, ...d.data() }) as PressRelease,
      )
      rows.sort((a, b) => {
        const at = a.updatedAt?.toMillis?.() ?? 0
        const bt = b.updatedAt?.toMillis?.() ?? 0
        return bt - at
      })
      setItems(rows)
      setLoading(false)
    })
  }, [])

  /** 年份取發佈日期；還沒填就退回建立時間。 */
  function yearOf(item: PressRelease): string {
    if (item.releaseDate) return item.releaseDate.slice(0, 4)
    const created = item.createdAt?.toDate?.()
    return created ? String(created.getFullYear()) : ''
  }

  const years = useMemo(
    () =>
      Array.from(new Set(items.map(yearOf).filter(Boolean))).sort((a, b) =>
        b.localeCompare(a),
      ),
    [items],
  )

  const visible = useMemo(
    () =>
      items.filter((i) => {
        if (category !== 'all' && i.category !== category) return false
        if (year !== 'all' && yearOf(i) !== year) return false
        return true
      }),
    [items, category, year],
  )

  const active = visible.filter((i) => !i.archived)
  const archived = visible.filter((i) => i.archived)

  async function createDraft() {
    const ref = await addDoc(collection(db, 'pressReleases'), {
      title: '未命名新聞稿',
      category: 'brand' satisfies Category,
      releaseDate: todayIso(),
      versions: blankVersions(),
      attachments: [],
      status: 'draft',
      archived: false,
      createdBy: appUser?.email ?? '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    navigate(`/press/${ref.id}`)
  }

  async function toggleArchive(e: React.MouseEvent, item: PressRelease) {
    e.stopPropagation()
    await updateDoc(doc(db, 'pressReleases', item.id), {
      archived: !item.archived,
      updatedAt: serverTimestamp(),
    })
  }

  async function remove(e: React.MouseEvent, item: PressRelease) {
    e.stopPropagation()
    if (!confirm(`確定要刪除「${item.title}」嗎？`)) return
    await deleteDoc(doc(db, 'pressReleases', item.id))
  }

  function renderRow(item: PressRelease) {
    const filled = LANGUAGES.filter(
      (l) => item.versions?.[l]?.subject?.trim(),
    ).length
    return (
      <div
        key={item.id}
        onClick={() => navigate(`/press/${item.id}`)}
        className={`flex cursor-pointer items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand-200 hover:shadow-sm ${
          item.archived ? 'opacity-70' : ''
        }`}
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
          <FileText className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-slate-900">
            {item.title}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <Badge>{CATEGORY_LABELS[item.category]}</Badge>
            {item.releaseDate && <span>{item.releaseDate}</span>}
            <span>·</span>
            <span>已填 {filled}/3 個語言版本</span>
            <span>·</span>
            <span>更新於 {formatDate(item.updatedAt)}</span>
          </div>
        </div>
        <Badge tone={item.status === 'sent' ? 'green' : 'amber'}>
          {item.status === 'sent' ? '已發送' : '草稿'}
        </Badge>
        <button
          onClick={(e) => toggleArchive(e, item)}
          title={item.archived ? '取消封存' : '封存'}
          className="rounded-lg p-2 text-slate-300 transition hover:bg-slate-100 hover:text-slate-600"
        >
          {item.archived ? (
            <ArchiveRestore className="size-4" />
          ) : (
            <Archive className="size-4" />
          )}
        </button>
        <button
          onClick={(e) => remove(e, item)}
          title="刪除"
          className="rounded-lg p-2 text-slate-300 transition hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    )
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
        <div className="mb-5 flex flex-wrap gap-3">
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category | 'all')}
            className="w-44"
          >
            <option value="all">全部分類</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
          <Select
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="w-36"
          >
            <option value="all">全部年份</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y} 年
              </option>
            ))}
          </Select>
        </div>

        {loading ? (
          <p className="py-16 text-center text-sm text-slate-400">載入中…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            title="沒有符合條件的新聞稿"
            description="建立第一篇稿件，填好三個語言版本後即可發送。"
            action={
              <Button variant="primary" onClick={createDraft}>
                <Plus className="size-4" />
                新增新聞稿
              </Button>
            }
          />
        ) : (
          <div className="space-y-8">
            <section>
              <h2 className="mb-3 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                進行中（{active.length}）
              </h2>
              {active.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 bg-white py-8 text-center text-sm text-slate-400">
                  沒有進行中的新聞稿
                </p>
              ) : (
                <div className="grid gap-3">{active.map(renderRow)}</div>
              )}
            </section>

            {archived.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  <Archive className="size-3.5" />
                  已封存（{archived.length}）
                </h2>
                <div className="grid gap-3">{archived.map(renderRow)}</div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  )
}
