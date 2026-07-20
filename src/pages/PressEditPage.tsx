import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore'
import {
  ArrowLeft,
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
import type { EmailSettings, PressRelease, StoredFile } from '../types'
import { blankVersions, formatBytes } from '../lib/helpers'
import { deletePressFile, uploadPressFile } from '../lib/storage'
import { renderEmailHtml } from '../lib/emailTemplate'
import { downloadPdf, downloadWord } from '../lib/exportDoc'

export default function PressEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [press, setPress] = useState<PressRelease | null>(null)
  const [lang, setLang] = useState<Language>('tw')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')

  const heroInput = useRef<HTMLInputElement>(null)
  const attachInput = useRef<HTMLInputElement>(null)
  // 預覽要跟實際寄出的信一致，所以 logo 與新聞聯絡人也要帶進來
  const [emailSettings, setEmailSettings] = useState<EmailSettings | null>(null)

  useEffect(() => {
    getDoc(doc(db, 'settings', 'email')).then((snap) => {
      if (snap.exists()) setEmailSettings(snap.data() as EmailSettings)
    })
  }, [])

  useEffect(() => {
    if (!id) return
    getDoc(doc(db, 'pressReleases', id)).then((snap) => {
      if (snap.exists()) {
        const data = snap.data() as PressRelease
        setPress({
          ...data,
          id: snap.id,
          versions: { ...blankVersions(), ...data.versions },
          attachments: data.attachments ?? [],
        })
      }
      setLoading(false)
    })
  }, [id])

  function patch(updater: (p: PressRelease) => PressRelease) {
    setPress((prev) => (prev ? updater(prev) : prev))
    setDirty(true)
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

  async function save() {
    if (!press || !id) return
    setSaving(true)
    setError('')
    try {
      const { id: _id, createdAt: _c, ...rest } = press
      void _id
      void _c
      await updateDoc(doc(db, 'pressReleases', id), {
        ...rest,
        updatedAt: serverTimestamp(),
      })
      setDirty(false)
    } catch {
      setError('儲存失敗，請確認網路連線後再試。')
    } finally {
      setSaving(false)
    }
  }

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
      if (old?.path) await deletePressFile(old.path)
    } catch {
      setError('圖片上傳失敗。')
    } finally {
      setUploading(false)
    }
  }

  async function removeHero() {
    if (!press) return
    const old = press.versions[lang].heroImage
    patch((p) => {
      const next = { ...p.versions[lang] }
      delete next.heroImage
      return { ...p, versions: { ...p.versions, [lang]: next } }
    })
    if (old?.path) await deletePressFile(old.path)
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
    try {
      const uploaded: StoredFile[] = []
      for (const f of files) uploaded.push(await uploadPressFile(id, 'attachments', f))
      patch((p) => ({ ...p, attachments: [...p.attachments, ...uploaded] }))
    } catch {
      setError('附件上傳失敗。')
    } finally {
      setUploading(false)
    }
  }

  async function removeAttachment(file: StoredFile) {
    patch((p) => ({
      ...p,
      attachments: p.attachments.filter((a) => a.path !== file.path),
    }))
    await deletePressFile(file.path)
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

  return (
    <>
      <PageHeader
        title="編輯新聞稿"
        description={dirty ? '有尚未儲存的變更' : '所有變更已儲存'}
        actions={
          <>
            <Button onClick={() => navigate('/press')}>
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
            <Button variant="primary" onClick={save} disabled={saving || !dirty}>
              <Save className="size-4" />
              {saving ? '儲存中…' : '儲存'}
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (dirty) await save()
                navigate(`/send?press=${press.id}`)
              }}
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

        <div className="mb-6 grid grid-cols-4 gap-4 rounded-xl border border-slate-200 bg-white p-5">
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
          <Field label="發佈日期" hint="顯示在信件標題下方。">
            <TextInput
              type="date"
              value={press.releaseDate ?? ''}
              onChange={(e) =>
                patch((p) => ({ ...p, releaseDate: e.target.value }))
              }
            />
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
            <Field label="信件主旨">
              <TextInput
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
    </>
  )
}
