import { useEffect, useRef, useState } from 'react'
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { Contact, ImageIcon, Upload } from 'lucide-react'
import { db } from '../lib/firebase'
import { uploadBrandingFile } from '../lib/storage'
import { Button, Field, TextInput } from './ui'
import { LANGUAGES, LANGUAGE_LABELS, type Language } from '../constants'
import type { EmailSettings, PressContact } from '../types'

const BLANK: PressContact = { name: '', company: '', email: '', phone: '' }

function blankContacts(): Record<Language, PressContact> {
  return Object.fromEntries(LANGUAGES.map((l) => [l, { ...BLANK }])) as Record<
    Language,
    PressContact
  >
}

export default function PressContactsCard() {
  const [logoUrl, setLogoUrl] = useState('')
  const [contacts, setContacts] = useState(blankContacts())
  const [saved, setSaved] = useState<EmailSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState('')
  const logoInput = useRef<HTMLInputElement>(null)
  const uiLogoInput = useRef<HTMLInputElement>(null)
  const [uiLogoUrl, setUiLogoUrl] = useState('')
  const [savedUiLogo, setSavedUiLogo] = useState('')

  // 介面 logo 放在公開可讀的 settings/branding，登入頁在驗證前就要顯示
  useEffect(() => {
    return onSnapshot(doc(db, 'settings', 'branding'), (snap) => {
      const url = (snap.data()?.uiLogoUrl as string) ?? ''
      setSavedUiLogo(url)
      setUiLogoUrl(url)
    })
  }, [])

  async function onPick(
    e: React.ChangeEvent<HTMLInputElement>,
    set: (url: string) => void,
  ) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setMessage('')
    try {
      const stored = await uploadBrandingFile(file)
      set(stored.url)
      setMessage('Logo 已上傳，記得按下方「儲存」才會生效。')
    } catch {
      setMessage('Logo 上傳失敗，請確認檔案小於 2MB。')
    } finally {
      setUploading(false)
    }
  }

  const onLogoPick = (e: React.ChangeEvent<HTMLInputElement>) =>
    onPick(e, setLogoUrl)

  useEffect(() => {
    return onSnapshot(doc(db, 'settings', 'email'), (snap) => {
      const d = (snap.data() as EmailSettings) ?? {}
      setSaved(d)
      setLogoUrl(d.logoUrl ?? '')
      setContacts({ ...blankContacts(), ...(d.contacts ?? {}) })
    })
  }, [])

  function patch(lang: Language, field: keyof PressContact, value: string) {
    setContacts((prev) => ({
      ...prev,
      [lang]: { ...prev[lang], [field]: value },
    }))
  }

  async function save() {
    setSaving(true)
    setMessage('')
    try {
      await Promise.all([
        setDoc(
          doc(db, 'settings', 'email'),
          { logoUrl: logoUrl.trim(), contacts, updatedAt: serverTimestamp() },
          { merge: true },
        ),
        setDoc(
          doc(db, 'settings', 'branding'),
          { uiLogoUrl: uiLogoUrl.trim(), updatedAt: serverTimestamp() },
          { merge: true },
        ),
      ])
      setMessage('已儲存。')
    } catch {
      setMessage('儲存失敗，請稍後再試。')
    } finally {
      setSaving(false)
    }
  }

  const dirty =
    logoUrl.trim() !== (saved?.logoUrl ?? '') ||
    uiLogoUrl.trim() !== savedUiLogo ||
    JSON.stringify(contacts) !==
      JSON.stringify({ ...blankContacts(), ...(saved?.contacts ?? {}) })

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="mb-1 flex items-center gap-2">
        <Contact className="size-4 text-slate-400" />
        <h2 className="text-sm font-semibold text-slate-800">
          信件頁首與新聞聯絡人
        </h2>
      </div>
      <p className="mb-5 text-xs text-slate-400">
        套用到所有新聞稿。每個語言版本的聯絡人分開設定，寄出時會依收件人語言自動帶入。
      </p>

      <div className="mb-6 max-w-2xl">
        <Field
          label="頁首 Logo"
          hint="建議白色、透明背景的 PNG，高度 64px 以上（顯示時縮到 32px，2 倍尺寸才不會糊）。留空則顯示文字版 TRANSCEND。"
        >
          <div className="flex gap-2">
            <TextInput
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="上傳圖片，或直接貼上網址"
            />
            <Button
              onClick={() => logoInput.current?.click()}
              disabled={uploading}
              className="shrink-0"
            >
              <Upload className="size-4" />
              {uploading ? '上傳中…' : '上傳'}
            </Button>
            {logoUrl && (
              <Button
                variant="ghost"
                onClick={() => setLogoUrl('')}
                className="shrink-0"
              >
                清除
              </Button>
            )}
          </div>
          <input
            ref={logoInput}
            type="file"
            accept="image/png,image/jpeg,image/gif"
            hidden
            onChange={onLogoPick}
          />
        </Field>
        <div
          className="mt-3 flex h-16 items-center rounded-lg px-6"
          style={{ backgroundColor: '#960014' }}
        >
          {logoUrl.trim() ? (
            <img
              src={logoUrl}
              alt="logo 預覽"
              className="h-8 w-auto"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          ) : (
            <span className="text-lg font-bold tracking-wide text-white">
              TRANSCEND
            </span>
          )}
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-400">
          <ImageIcon className="size-3.5" />
          這是信件頁首的實際樣子（底色 #960014）
        </p>

        <div className="mt-6">
          <Field
            label="系統介面 Logo"
            hint="顯示在登入頁與左側選單。這裡是白底，要用深色版本的 logo。"
          >
            <div className="flex gap-2">
              <TextInput
                value={uiLogoUrl}
                onChange={(e) => setUiLogoUrl(e.target.value)}
                placeholder="上傳圖片，或直接貼上網址"
              />
              <Button
                onClick={() => uiLogoInput.current?.click()}
                disabled={uploading}
                className="shrink-0"
              >
                <Upload className="size-4" />
                上傳
              </Button>
              {uiLogoUrl && (
                <Button
                  variant="ghost"
                  onClick={() => setUiLogoUrl('')}
                  className="shrink-0"
                >
                  清除
                </Button>
              )}
            </div>
            <input
              ref={uiLogoInput}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml"
              hidden
              onChange={(e) => onPick(e, setUiLogoUrl)}
            />
          </Field>
          <div className="mt-3 flex h-16 items-center rounded-lg border border-slate-200 bg-white px-6">
            {uiLogoUrl.trim() ? (
              <img
                src={uiLogoUrl}
                alt="介面 logo 預覽"
                className="h-7 w-auto"
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
              />
            ) : (
              <span className="text-sm text-slate-400">
                未設定，介面會顯示預設圖示
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-5">
        {LANGUAGES.map((l) => (
          <div key={l} className="rounded-lg border border-slate-200 p-4">
            <h3 className="mb-3 text-xs font-semibold text-slate-600">
              {LANGUAGE_LABELS[l]}
            </h3>
            <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
              <Field label="姓名">
                <TextInput
                  value={contacts[l].name}
                  onChange={(e) => patch(l, 'name', e.target.value)}
                  placeholder={l === 'tw' ? '林筱涵' : 'Rachel Lin'}
                />
              </Field>
              <Field label="公司 / 部門">
                <TextInput
                  value={contacts[l].company}
                  onChange={(e) => patch(l, 'company', e.target.value)}
                  placeholder={
                    l === 'tw' ? '創見資訊 行銷部' : 'Transcend Information Inc.'
                  }
                />
              </Field>
              <Field label="Email">
                <TextInput
                  value={contacts[l].email}
                  onChange={(e) => patch(l, 'email', e.target.value)}
                  placeholder={
                    l === 'us'
                      ? 'PR-US@transcend-info.com'
                      : 'pr@transcend-info.com'
                  }
                />
              </Field>
              <Field label="電話">
                <TextInput
                  value={contacts[l].phone}
                  onChange={(e) => patch(l, 'phone', e.target.value)}
                  placeholder={
                    l === 'us'
                      ? 'Tel: (714) 921-2000 ext 2250'
                      : 'Tel: 02-2792-8000 ext. 7592'
                  }
                />
              </Field>
            </div>
          </div>
        ))}
      </div>

      {message && (
        <div className="mt-5 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
          {message}
        </div>
      )}

      <div className="mt-5">
        <Button variant="primary" onClick={save} disabled={saving || !dirty}>
          {saving ? '儲存中…' : '儲存'}
        </Button>
      </div>
    </div>
  )
}
