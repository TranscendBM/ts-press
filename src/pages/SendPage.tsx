import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { AlertTriangle, CheckCircle2, Send, TestTube2 } from 'lucide-react'
import { db, functions } from '../lib/firebase'
import { useAuth } from '../lib/AuthContext'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Modal, Select } from '../components/ui'
import {
  CATEGORY_LABELS,
  INTERNAL_LISTS,
  LANGUAGE_LABELS,
  LISTS,
  LIST_LABELS,
  REPLY_TO_EMAIL,
  type Language,
  type ListId,
} from '../constants'
import type { MediaContact, PressRelease } from '../types'
import { blankVersions, formatBytes } from '../lib/helpers'

type SendMode = 'self' | 'testList' | 'real'

const sendCampaign = httpsCallable<
  { pressReleaseId: string; targetLists?: ListId[]; mode: SendMode },
  { campaignId: string; recipients: number }
>(functions, 'sendCampaign')

export default function SendPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { appUser, can } = useAuth()
  const canSendTest = can('sendTest')
  const canSend = can('sendReal')

  const [presses, setPresses] = useState<PressRelease[]>([])
  const [contacts, setContacts] = useState<MediaContact[]>([])
  const [pressId, setPressId] = useState(params.get('press') ?? '')
  const [selected, setSelected] = useState<ListId[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{
    tone: 'ok' | 'error'
    text: string
  } | null>(null)

  useEffect(() => {
    async function load() {
      const [pSnap, cSnap] = await Promise.all([
        getDocs(query(collection(db, 'pressReleases'), orderBy('updatedAt', 'desc'))),
        getDocs(collection(db, 'mediaContacts')),
      ])
      setPresses(
        pSnap.docs.map((d) => {
          const data = d.data() as PressRelease
          return {
            ...data,
            id: d.id,
            versions: { ...blankVersions(), ...data.versions },
          }
        }),
      )
      setContacts(
        cSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as MediaContact),
      )
      setLoading(false)
    }
    load()
  }, [])

  const press = useMemo(
    () => presses.find((p) => p.id === pressId) ?? null,
    [presses, pressId],
  )

  /** 依勾選的名單展開收件人，同一個 email 只留一份。 */
  const recipients = useMemo(() => {
    if (selected.length === 0) return []
    const map = new Map<string, MediaContact>()
    for (const c of contacts) {
      if (c.active === false) continue
      if (!(c.lists ?? []).some((l) => selected.includes(l))) continue
      if (!map.has(c.email)) map.set(c.email, c)
    }
    return Array.from(map.values())
  }, [contacts, selected])

  const byLanguage = useMemo(() => {
    const map: Record<Language, MediaContact[]> = { tw: [], www: [], us: [] }
    for (const r of recipients) map[r.language]?.push(r)
    return map
  }, [recipients])

  /** 有收件人、但對應語言版本沒填主旨或內文 → 擋下發送。 */
  const missingVersions = useMemo(() => {
    if (!press) return []
    return (Object.keys(byLanguage) as Language[]).filter((l) => {
      if (byLanguage[l].length === 0) return false
      const v = press.versions[l]
      return !v?.subject?.trim() || !v?.bodyText?.trim()
    })
  }, [press, byLanguage])

  const attachTotal = press?.attachments?.reduce((s, a) => s + a.size, 0) ?? 0
  const testListCount = contacts.filter(
    (c) => c.active !== false && (c.lists ?? []).includes('test'),
  ).length
  const readyToSend =
    !!press && recipients.length > 0 && missingVersions.length === 0

  function toggle(l: ListId) {
    setSelected((prev) =>
      prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l],
    )
  }

  async function run(mode: SendMode) {
    if (!press) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await sendCampaign({
        pressReleaseId: press.id,
        targetLists: mode === 'real' ? selected : undefined,
        mode,
      })
      setConfirmOpen(false)
      if (mode === 'self') {
        setMessage({
          tone: 'ok',
          text: `測試信已寄至 ${appUser?.email}，請到信箱確認排版、圖片與附件。`,
        })
      } else if (mode === 'testList') {
        setMessage({
          tone: 'ok',
          text: `已寄給測試名單共 ${res.data.recipients} 位，可到發送紀錄查看結果。`,
        })
      } else {
        navigate(`/campaigns/${res.data.campaignId}`)
      }
    } catch (err) {
      setMessage({
        tone: 'error',
        text: (err as { message?: string }).message ?? '發送失敗，請稍後再試。',
      })
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <p className="p-16 text-center text-sm text-slate-400">載入中…</p>
  }

  return (
    <>
      <PageHeader
        title="發送新聞稿"
        description={`透過公司 mail2000 寄出，一位記者一封獨立信件；記者回信會進 ${REPLY_TO_EMAIL}。`}
      />

      <div className="max-w-4xl space-y-6 p-8">
        {message && (
          <div
            className={`rounded-lg p-3 text-sm ${
              message.tone === 'ok'
                ? 'bg-emerald-50 text-emerald-800'
                : 'bg-red-50 text-red-700'
            }`}
          >
            {message.text}
          </div>
        )}

        <Card step="1" title="選擇新聞稿">
          <Select
            value={pressId}
            onChange={(e) => setPressId(e.target.value)}
          >
            <option value="">— 請選擇 —</option>
            {presses.map((p) => (
              <option key={p.id} value={p.id}>
                [{CATEGORY_LABELS[p.category]}] {p.title}
              </option>
            ))}
          </Select>

          {press && (
            <div className="mt-4 space-y-2 rounded-lg bg-slate-50 p-4 text-sm">
              {(Object.keys(LANGUAGE_LABELS) as Language[]).map((l) => {
                const v = press.versions[l]
                const ok = v?.subject?.trim() && v?.bodyText?.trim()
                return (
                  <div key={l} className="flex items-start gap-2">
                    {ok ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    )}
                    <div className="min-w-0">
                      <span className="text-slate-500">
                        {LANGUAGE_LABELS[l]}：
                      </span>
                      <span className="text-slate-800">
                        {v?.subject?.trim().replace(/\s*\n\s*/g, ' ') ||
                          '（未填寫）'}
                      </span>
                    </div>
                  </div>
                )
              })}
              <div className="border-t border-slate-200 pt-2 text-xs text-slate-500">
                附件 {press.attachments?.length ?? 0} 個 ·{' '}
                {formatBytes(attachTotal)}
              </div>
              <button
                onClick={() => navigate(`/press/${press.id}`)}
                className="text-xs text-brand-700 underline-offset-2 hover:underline"
              >
                編輯這篇稿件
              </button>
            </div>
          )}
        </Card>

        <Card step="2" title="寄送測試信">
          <p className="mb-4 text-sm text-slate-500">
            這一區的按鈕<b className="text-slate-700">永遠不會寄給媒體名單</b>
            ，與下方的正式發送完全獨立。
          </p>
          {!canSendTest && (
            <div className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              你的角色沒有發送權限，包含測試信。可以編輯稿件與下載檔案。
            </div>
          )}

          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 p-4">
              <div className="mb-1 text-sm font-medium text-slate-800">
                寄給我自己
              </div>
              <p className="mb-3 text-xs text-slate-500">
                已填寫的每個語言版本各寄一封到 {appUser?.email}，方便一次核對三個版本。
              </p>
              <Button
                onClick={() => run('self')}
                disabled={
                  busy || !press || !canSendTest || missingVersions.length > 0
                }
              >
                <TestTube2 className="size-4" />
                寄測試信給我
              </Button>
            </div>

            <div className="rounded-lg border border-slate-200 p-4">
              <div className="mb-1 text-sm font-medium text-slate-800">
                寄給測試名單
              </div>
              <p className="mb-3 text-xs text-slate-500">
                完整演練：流程與真實發稿相同，但只寄給「測試名單」裡的{' '}
                {testListCount} 位內部同仁。
              </p>
              <Button
                onClick={() => run('testList')}
                disabled={
                  busy ||
                  !press ||
                  !canSendTest ||
                  testListCount === 0 ||
                  missingVersions.length > 0
                }
              >
                <TestTube2 className="size-4" />
                寄測試信給測試名單（{testListCount} 位）
              </Button>
              {testListCount === 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  測試名單還沒有人，請先到「媒體名單」把同仁加進「測試名單」。
                </p>
              )}
            </div>
          </div>
        </Card>

        <Card step="3" title="正式發送">
          <div className="mb-4 flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>以下按鈕會真的寄給媒體記者，送出後無法收回。</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {/* 測試名單不出現在這裡，只能由上方的測試按鈕觸發 */}
            {LISTS.filter((l) => !INTERNAL_LISTS.includes(l)).map((l) => {
              const count = contacts.filter(
                (c) => c.active !== false && (c.lists ?? []).includes(l),
              ).length
              const on = selected.includes(l)
              const internal = INTERNAL_LISTS.includes(l)
              return (
                <button
                  key={l}
                  onClick={() => toggle(l)}
                  className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition ${
                    on
                      ? internal
                        ? 'border-amber-500 bg-amber-50'
                        : 'border-brand-500 bg-brand-50'
                      : 'border-slate-300 bg-white hover:bg-slate-50'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`text-sm font-medium ${
                        on
                          ? internal
                            ? 'text-amber-800'
                            : 'text-brand-700'
                          : 'text-slate-700'
                      }`}
                    >
                      {LIST_LABELS[l]}
                    </span>
                    {internal && <Badge tone="amber">內部</Badge>}
                  </span>
                  <Badge tone={on ? (internal ? 'amber' : 'blue') : 'slate'}>
                    {count} 位
                  </Badge>
                </button>
              )
            })}
          </div>

          {recipients.length > 0 && (
            <div className="mt-4 rounded-lg bg-slate-50 p-4 text-sm">
              <p className="mb-2 font-medium text-slate-800">
                共 {recipients.length} 位收件人（已自動去除重複 Email）
              </p>
              {(Object.keys(byLanguage) as Language[]).map((l) =>
                byLanguage[l].length > 0 ? (
                  <div key={l} className="text-slate-600">
                    {LANGUAGE_LABELS[l]} — {byLanguage[l].length} 位
                  </div>
                ) : null,
              )}
            </div>
          )}

          {missingVersions.length > 0 && (
            <div className="mt-4 flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                有收件人要收{' '}
                {missingVersions.map((l) => LANGUAGE_LABELS[l]).join('、')}{' '}
                版本，但這些版本的主旨或內文還沒填寫，無法發送。
              </span>
            </div>
          )}

          <div className="mt-5 border-t border-slate-200 pt-5">
            <Button
              variant="primary"
              onClick={() => setConfirmOpen(true)}
              disabled={busy || !readyToSend || !canSend}
            >
              <Send className="size-4" />
              正式發送
              {recipients.length > 0 && `（${recipients.length} 位）`}
            </Button>
            {!canSend && (
              <p className="mt-3 text-xs text-amber-700">
                你的角色沒有正式發送權限，僅能寄送測試信。
              </p>
            )}
          </div>
        </Card>
      </div>

      <Modal
        open={confirmOpen}
        title="確認發送"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button variant="danger" onClick={() => run('real')} disabled={busy}>
              {busy ? '發送中…' : '確認發送'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-slate-700">
          <p>即將把以下新聞稿寄給 {recipients.length} 位媒體聯絡人：</p>
          <div className="rounded-lg bg-slate-50 p-4">
            <div className="font-medium text-slate-900">{press?.title}</div>
            <div className="mt-1 text-xs text-slate-500">
              名單：{selected.map((l) => LIST_LABELS[l]).join('、')}
            </div>
          </div>
          <p className="text-amber-700">
            發送後無法收回，請確認已寄過測試信並檢查無誤。
          </p>
        </div>
      </Modal>
    </>
  )
}

function Card({
  step,
  title,
  children,
}: {
  step: string
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex size-6 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
          {step}
        </span>
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      </div>
      {children}
    </div>
  )
}
