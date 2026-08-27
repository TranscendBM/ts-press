import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { createAutosaveController, type AutosaveController } from '../lib/autosave'
import {
  ArrowLeft,
  Check,
  Code2,
  Copy,
  Eye,
  FileDown,
  FileType,
  ImageIcon,
  Paperclip,
  Save,
  Send,
  Trash2,
} from 'lucide-react'
import { db } from '../lib/firebase'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Field, Modal, Select, TextArea, TextInput } from '../components/ui'
import {
  CATEGORIES,
  CATEGORY_LABELS,
  LANGUAGES,
  LANGUAGE_LABELS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  type Category,
  type Language,
} from '../constants'
import type { AppUser, EmailSettings, PressRelease, StoredFile } from '../types'
import { blankVersions, formatBytes } from '../lib/helpers'
import {
  deletePressFile,
  describeStorageError,
  uploadPressFile,
} from '../lib/storage'
import { renderBodyHtml, renderEmailHtml } from '../../shared/emailTemplate'
import { downloadPdf, downloadWord } from '../lib/exportDoc'
import { saveThenNavigate } from '../lib/saveThenNavigate'

export default function PressEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [press, setPress] = useState<PressRelease | null>(null)
  const [lang, setLang] = useState<Language>('tw')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  // 版本控制的自動儲存：一次只允許一個網路 request 在飛行，儲存期間又有新
  // 編輯就自動追加送出，避免「較新的內容還沒寫入卻被標成已儲存」。
  // 詳見 src/lib/autosave.ts 的說明。
  const controllerRef = useRef<AutosaveController<PressRelease> | null>(null)
  // 存最新的 save，讓自動儲存的計時器永遠呼叫到當前 render 的版本
  const saveRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false))
  const [previewOpen, setPreviewOpen] = useState(false)
  const [htmlOpen, setHtmlOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')

  const heroInput = useRef<HTMLInputElement>(null)
  const attachInput = useRef<HTMLInputElement>(null)
  // 預覽要跟實際寄出的信一致，所以 logo 與新聞聯絡人也要帶進來
  const [emailSettings, setEmailSettings] = useState<EmailSettings | null>(null)
  // 負責人下拉：列出所有白名單使用者
  const [users, setUsers] = useState<AppUser[]>([])

  useEffect(() => {
    getDoc(doc(db, 'settings', 'email')).then((snap) => {
      if (snap.exists()) setEmailSettings(snap.data() as EmailSettings)
    })
    getDocs(collection(db, 'users')).then((snap) => {
      const list = snap.docs.map((d) => d.data() as AppUser)
      list.sort((a, b) =>
        (a.displayName || a.email).localeCompare(b.displayName || b.email),
      )
      setUsers(list)
    })
  }, [])

  useEffect(() => {
    if (!id) return
    getDoc(doc(db, 'pressReleases', id)).then((snap) => {
      if (snap.exists()) {
        const data = snap.data() as PressRelease
        const initial: PressRelease = {
          ...data,
          id: snap.id,
          versions: { ...blankVersions(), ...data.versions },
          attachments: data.attachments ?? [],
        }
        setPress(initial)
        controllerRef.current = createAutosaveController(initial, {
          write: async (snapshot) => {
            const { id: _id, createdAt: _c, ...rest } = snapshot
            void _id
            void _c
            await updateDoc(doc(db, 'pressReleases', id), {
              ...rest,
              updatedAt: serverTimestamp(),
            })
          },
          onSavingChange: (v) => {
            setSaving(v)
            if (v) setError('')
          },
          onDirtyChange: setDirty,
          onSaved: setLastSavedAt,
          onError: (err) => {
            console.error('儲存新聞稿失敗', err)
            setError(
              `儲存失敗，內容尚未寫入資料庫：${(err as Error)?.message ?? '請確認網路連線後再試。'}`,
            )
          },
        })
      }
      setLoading(false)
    })
  }, [id])

  // 只在瀏覽器關閉分頁／重新整理時提醒 —— 站內導航（返回、前往發送）
  // 各自已透過 saveThenNavigate 保證離開前存檔或阻擋離開。
  useEffect(() => {
    if (!dirty) return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  function patch(updater: (p: PressRelease) => PressRelease) {
    if (!press) return
    const next = updater(press)
    setPress(next)
    controllerRef.current?.markEdited(next)
  }

  function patchVersion(field: 'subject' | 'bodyText', value: string) {
    patch((p) => ({
      ...p,
      versions: {
        ...p.versions,
        [lang]: { ...p.versions[lang], [field]: value },
      },
    }))
  }

  /**
   * 儲存稿件。回傳是否成功 —— 呼叫端（例如「前往發送」）必須依這個結果
   * 決定要不要離開頁面，否則儲存失敗時使用者會帶著未存檔的內容去發送。
   *
   * 若儲存期間又發生新編輯，controllerRef 會自動追送最新內容，這裡回傳的
   * 是「呼叫當下最新的內容」是否確實寫入，而不是某一次過期 request 的結果。
   */
  async function save(): Promise<boolean> {
    return (await controllerRef.current?.save()) ?? false
  }

  saveRef.current = save

  // 自動儲存：停止編輯約 1.5 秒後自動存一次。
  // 依賴 press，每次內容變動就重設計時器，達成「停止輸入才存」的效果。
  useEffect(() => {
    if (!dirty || saving) return
    const timer = setTimeout(() => {
      void saveRef.current()
    }, 1500)
    return () => clearTimeout(timer)
  }, [press, dirty, saving])

  /**
   * 檔案異動一律「先確認 Firestore 已經寫入新的參照，才刪除舊檔案」。
   *
   * 先前是反過來：本地狀態一改就先刪 Storage 檔案，實際寫進 Firestore
   * 要等 1.5 秒的自動儲存防抖才會發生。如果那個空檔內分頁被關掉、或
   * 這次自動儲存剛好失敗，資料庫裡留著的就是「已經被刪除的舊檔案路徑」
   * ——記者收到的信、後台的下載連結都會指到一個不存在的檔案。
   * 换成先寫 Firestore（呼叫 save() 立即送出，不等防抖），確認成功後
   * 才刪舊檔，最壞情況只是留下一個沒人引用的孤兒檔案，而不是壞掉的參照。
   */
  async function onHeroPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !press || !id) return
    setUploading(true)
    setError('')
    try {
      const old = press.versions[lang].heroImage
      const stored = await uploadPressFile(id, 'hero', file)
      patch((p) => ({
        ...p,
        versions: {
          ...p.versions,
          [lang]: { ...p.versions[lang], heroImage: stored },
        },
      }))
      const saved = await save()
      if (saved && old?.path) {
        await deletePressFile(old.path)
      } else if (!saved) {
        setError(
          '圖片已上傳，但儲存變更時發生錯誤，請確認網路連線，系統會自動重試。',
        )
      }
    } catch (err) {
      setError(`圖片上傳失敗：${describeStorageError(err)}`)
    } finally {
      setUploading(false)
    }
  }

  async function removeHero() {
    if (!press) return
    const old = press.versions[lang].heroImage
    if (!old) return
    setError('')
    patch((p) => {
      const next = { ...p.versions[lang] }
      delete next.heroImage
      return { ...p, versions: { ...p.versions, [lang]: next } }
    })
    const saved = await save()
    if (!saved) {
      setError(
        '圖片移除尚未儲存成功，請確認網路連線，系統會自動重試；重試成功前檔案不會被刪除。',
      )
      return
    }
    try {
      await deletePressFile(old.path)
    } catch (err) {
      // Firestore 已經確認移除參照，這裡失敗只留下孤兒檔案，不影響資料正確性
      console.error('刪除舊圖片檔案失敗（僅留下孤兒檔案，資料本身正確）', err)
    }
  }

  async function onAttachPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0 || !press || !id) return

    const current = press.attachments.reduce((sum, a) => sum + a.size, 0)
    const incoming = files.reduce((sum, f) => sum + f.size, 0)
    if (current + incoming > MAX_ATTACHMENT_TOTAL_BYTES) {
      setError(
        `附件總大小超過 ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}，請壓縮圖片或減少檔案數。`,
      )
      return
    }

    setUploading(true)
    setError('')
    const uploaded: StoredFile[] = []
    try {
      for (const f of files) uploaded.push(await uploadPressFile(id, 'attachments', f))
    } catch (err) {
      // 這批裡已經成功上傳、但整批因為某個檔案失敗而不會寫入 Firestore 的
      // 檔案要立刻清掉，否則會變成沒有任何文件引用的孤兒檔案。
      for (const u of uploaded) {
        try {
          await deletePressFile(u.path)
        } catch (cleanupErr) {
          console.error('回收上傳失敗的附件時發生錯誤（可能留下孤兒檔案）', cleanupErr)
        }
      }
      setError(`附件上傳失敗：${describeStorageError(err)}`)
      setUploading(false)
      return
    }

    patch((p) => ({ ...p, attachments: [...p.attachments, ...uploaded] }))
    const saved = await save()
    if (!saved) {
      // 這裡不能刪除剛上傳的檔案 —— 本地狀態已經記著它們，一旦之後自動
      // 儲存重試成功，Firestore 就會引用到它們；現在刪掉反而會造成
      // 「引用已刪除檔案」的問題。留著讓自動儲存重試即可。
      setError(
        '附件已上傳，但儲存變更時發生錯誤，請確認網路連線，系統會自動重試。',
      )
    }
    setUploading(false)
  }

  async function removeAttachment(file: StoredFile) {
    setError('')
    patch((p) => ({
      ...p,
      attachments: p.attachments.filter((a) => a.path !== file.path),
    }))
    const saved = await save()
    if (!saved) {
      setError(
        '附件移除尚未儲存成功，請確認網路連線，系統會自動重試；重試成功前檔案不會被刪除。',
      )
      return
    }
    try {
      await deletePressFile(file.path)
    } catch (err) {
      console.error('刪除孤立附件檔案失敗（僅留下孤兒檔案，資料本身正確）', err)
    }
  }

  if (loading) {
    return <p className="p-16 text-center text-sm text-slate-400">載入中…</p>
  }
  if (!press) {
    return <p className="p-16 text-center text-sm text-slate-400">找不到這篇新聞稿。</p>
  }

  const version = press.versions[lang]
  const attachTotal = press.attachments.reduce((s, a) => s + a.size, 0)

  // 下載與預覽共用同一份資料，確保看到的跟寄出的一致
  const templateInput = {
    subject: version.subject || '（尚未填寫主旨）',
    bodyText: version.bodyText || '（尚未填寫內文）',
    heroImageUrl: version.heroImage?.url,
    recipientName: '',
    language: lang,
    releaseDate: press.releaseDate,
    logoUrl: emailSettings?.logoUrl,
    contact: emailSettings?.contacts?.[lang],
    about: emailSettings?.about?.[lang]?.text,
    aboutLink: emailSettings?.about?.[lang]?.link,
  }
  const downloadName = `${press.title || '新聞稿'}_${lang}`

  // 內文轉乾淨語意 HTML（<p>/<h4>/<a>），供貼進公司 CMS 後台
  const bodyHtml = renderBodyHtml(version.bodyText || '')
  async function copyBodyHtml() {
    try {
      await navigator.clipboard.writeText(bodyHtml)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <>
      <PageHeader
        title="編輯新聞稿"
        description={
          saving
            ? '儲存中…'
            : dirty
              ? '編輯中，將自動儲存…'
              : lastSavedAt
                ? `已自動儲存 ${lastSavedAt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                : '所有變更已儲存'
        }
        actions={
          <>
            <Button
              onClick={() => {
                // 還有未儲存的內容（例如剛打完字、自動儲存的 1.5 秒防抖還沒到）
                // 就提醒一次，避免使用者以為已經存了、其實還沒送出。
                if (dirty && !confirm('有尚未儲存的變更，確定要離開嗎？')) return
                navigate('/press')
              }}
            >
              <ArrowLeft className="size-4" />
              返回
            </Button>
            <Button onClick={() => setPreviewOpen(true)}>
              <Eye className="size-4" />
              預覽
            </Button>
            <Button
              onClick={async () => {
                setDownloading(true)
                try {
                  await downloadWord(templateInput, downloadName)
                } finally {
                  setDownloading(false)
                }
              }}
              disabled={downloading}
            >
              <FileType className="size-4" />
              {downloading ? '產生中…' : 'Word'}
            </Button>
            <Button onClick={() => downloadPdf(templateInput, downloadName)}>
              <FileDown className="size-4" />
              PDF
            </Button>
            <Button
              onClick={() => {
                setCopied(false)
                setHtmlOpen(true)
              }}
            >
              <Code2 className="size-4" />
              HTML
            </Button>
            <Button variant="primary" onClick={save} disabled={saving || !dirty}>
              <Save className="size-4" />
              {saving ? '儲存中…' : '儲存'}
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                // 儲存失敗就留在編輯頁，錯誤訊息已顯示在上方
                saveThenNavigate({
                  dirty,
                  save,
                  navigate: () => navigate(`/send?press=${press.id}`),
                })
              }
            >
              <Send className="size-4" />
              前往發送
            </Button>
          </>
        }
      />

      <div className="p-8">
        {error && (
          <div className="mb-5 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mb-6 grid grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-6">
          <div className="col-span-2">
            <Field label="稿件標題（僅供後台辨識）">
              <TextInput
                value={press.title}
                onChange={(e) => patch((p) => ({ ...p, title: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="分類">
            <Select
              value={press.category}
              onChange={(e) =>
                patch((p) => ({ ...p, category: e.target.value as Category }))
              }
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="發佈日期" hint="印在信件標題下方。">
            <TextInput
              type="date"
              value={press.releaseDate ?? ''}
              onChange={(e) =>
                patch((p) => ({ ...p, releaseDate: e.target.value }))
              }
            />
          </Field>
          <Field label="計畫發送日期" hint="內部排程用，不印在信上。">
            <TextInput
              type="date"
              value={press.scheduledDate ?? ''}
              onChange={(e) =>
                patch((p) => ({ ...p, scheduledDate: e.target.value }))
              }
            />
          </Field>
          <Field label="負責人">
            <Select
              value={press.ownerEmail ?? ''}
              onChange={(e) => {
                const email = e.target.value
                const u = users.find((x) => x.email === email)
                patch((p) => ({
                  ...p,
                  ownerEmail: email,
                  ownerName: u?.displayName || email,
                }))
              }}
            >
              <option value="">（未指定）</option>
              {users.map((u) => (
                <option key={u.email} value={u.email}>
                  {u.displayName || u.email}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white">
          <div className="flex gap-1 border-b border-slate-200 px-5 pt-4">
            {LANGUAGES.map((l) => {
              const done = press.versions[l]?.subject?.trim()
              return (
                <button
                  key={l}
                  onClick={() => setLang(l)}
                  className={`flex items-center gap-2 rounded-t-lg px-4 py-2.5 text-sm font-medium transition ${
                    lang === l
                      ? 'border-b-2 border-brand-600 text-brand-700'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {LANGUAGE_LABELS[l]}
                  {done ? (
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-slate-300" />
                  )}
                </button>
              )
            })}
          </div>

          <div className="space-y-5 p-5">
            <Field
              label="信件主旨"
              hint="按 Enter 可手動斷行；斷行只顯示在信件內文、Word、PDF 的大標題，收件匣看到的主旨仍是一行。"
            >
              <TextArea
                rows={2}
                value={version.subject}
                onChange={(e) => patchVersion('subject', e.target.value)}
                placeholder={
                  lang === 'tw' ? '創見資訊發表…' : 'Transcend Announces…'
                }
              />
            </Field>

            <Field
              label="內文"
              hint="空一行代表分段。開頭加「## 」的行會變成小標題。網址會自動變成連結。"
            >
              <TextArea
                rows={16}
                value={version.bodyText}
                onChange={(e) => patchVersion('bodyText', e.target.value)}
                className="leading-relaxed"
              />
            </Field>

            <Field label="內文圖片" hint="會內嵌顯示在內文最上方，建議寬度 600px 以上。">
              {version.heroImage ? (
                <div className="flex items-center gap-4 rounded-lg border border-slate-200 p-3">
                  <img
                    src={version.heroImage.url}
                    alt=""
                    className="h-16 w-24 rounded object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-slate-700">
                      {version.heroImage.name}
                    </div>
                    <div className="text-xs text-slate-400">
                      {formatBytes(version.heroImage.size)}
                    </div>
                  </div>
                  <Button variant="ghost" onClick={removeHero}>
                    <Trash2 className="size-4" />
                    移除
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={() => heroInput.current?.click()}
                  disabled={uploading}
                >
                  <ImageIcon className="size-4" />
                  上傳圖片
                </Button>
              )}
              <input
                ref={heroInput}
                type="file"
                accept="image/*"
                hidden
                onChange={onHeroPick}
              />
            </Field>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">
                郵件附件
              </h3>
              <p className="mt-0.5 text-xs text-slate-400">
                三個語言版本共用。已使用 {formatBytes(attachTotal)} /{' '}
                {formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}
              </p>
            </div>
            <Button
              onClick={() => attachInput.current?.click()}
              disabled={uploading}
            >
              <Paperclip className="size-4" />
              {uploading ? '上傳中…' : '加入附件'}
            </Button>
            <input
              ref={attachInput}
              type="file"
              multiple
              hidden
              onChange={onAttachPick}
            />
          </div>

          {press.attachments.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">
              尚未加入附件
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {press.attachments.map((a) => (
                <div key={a.path} className="flex items-center gap-3 py-2.5">
                  <Paperclip className="size-4 shrink-0 text-slate-400" />
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate text-sm text-slate-700 hover:text-brand-700"
                  >
                    {a.name}
                  </a>
                  <Badge>{formatBytes(a.size)}</Badge>
                  <button
                    onClick={() => removeAttachment(a)}
                    className="rounded-lg p-1.5 text-slate-300 transition hover:bg-red-50 hover:text-red-600"
                    title="移除"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={previewOpen}
        wide
        title={`預覽 — ${LANGUAGE_LABELS[lang]}`}
        onClose={() => setPreviewOpen(false)}
        footer={<Button onClick={() => setPreviewOpen(false)}>關閉</Button>}
      >
        <iframe
          title="email-preview"
          className="h-[60vh] w-full rounded-lg border border-slate-200"
          srcDoc={renderEmailHtml(templateInput)}
        />
      </Modal>

      <Modal
        open={htmlOpen}
        wide
        title={`內文 HTML — ${LANGUAGE_LABELS[lang]}`}
        onClose={() => setHtmlOpen(false)}
        footer={
          <>
            <Button onClick={() => setHtmlOpen(false)}>關閉</Button>
            <Button variant="primary" onClick={copyBodyHtml}>
              {copied ? (
                <>
                  <Check className="size-4" />
                  已複製
                </>
              ) : (
                <>
                  <Copy className="size-4" />
                  複製 HTML
                </>
              )}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-xs text-slate-500">
          目前語言版本的內文，已轉成乾淨的 HTML（段落 <code>&lt;p&gt;</code>、小標題{' '}
          <code>&lt;h4&gt;</code>、連結 <code>&lt;a&gt;</code>），可直接貼進公司後台。
          不含標題、圖片與附件。
        </p>
        <textarea
          readOnly
          value={bodyHtml}
          onFocus={(e) => e.currentTarget.select()}
          className="h-[52vh] w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800"
        />
      </Modal>
    </>
  )
}
