/**
 * sendCampaign／retryCampaign 的純決策邏輯。
 *
 * 跟 shared/policy.ts、shared/pressCleanup.ts 一樣的理由：Functions 的
 * index.ts 一載入就會 initializeApp()，測試沒辦法直接匯入，所以把「要不要
 * 重建收件人、要不要重跑、這次該處理誰、最後狀態該落在哪」這些純粹的判斷
 * 抽出來，用假資料就能測，不必連 Firestore 或真的寄信。
 */

/** 只接受一段安全的字元組合，避免被塞進奇怪的 Firestore 文件 ID。 */
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(key)
}

export interface ExistingCampaignSummary {
  pressReleaseId?: string
  mode?: string
  status?: string
}

export type ResumeDecision =
  | { action: 'create' }
  | { action: 'return-existing-result' }
  | { action: 'resume' }
  | { action: 'reject'; reason: string }

/**
 * 依「是否已有同一個 idempotencyKey 對應的 campaign 文件」與這次請求的內容，
 * 決定 sendCampaign 該怎麼做：
 * - create：全新建立（沒有既有文件，或沒帶 idempotencyKey）
 * - return-existing-result：之前已經跑完（不論成敗），直接回傳當時結果，不重跑
 * - resume：之前跑到一半（sending／partial），接續處理還沒確認寄出的收件人
 * - reject：同一個 key 被用在不同的新聞稿或不同的發送模式，視為誤用
 */
export function decideCampaignResume(
  existing: ExistingCampaignSummary | undefined,
  request: { pressReleaseId: string; mode: string },
): ResumeDecision {
  if (!existing) return { action: 'create' }
  if (
    existing.pressReleaseId !== request.pressReleaseId ||
    existing.mode !== request.mode
  ) {
    return {
      action: 'reject',
      reason:
        '這個發送識別碼已經用於另一次不同的發送，請重新整理頁面再試一次。',
    }
  }
  if (existing.status === 'completed' || existing.status === 'failed') {
    return { action: 'return-existing-result' }
  }
  return { action: 'resume' }
}

export type CampaignStatus = 'partial' | 'completed' | 'failed'

/**
 * 依處理完一輪之後的統計數字，決定 campaign 的最終狀態。
 * remaining > 0（撞到單批上限，還有人沒處理到）永遠是 partial，
 * 不論這一輪本身成功或失敗；只有全部處理完才會落在 completed／failed。
 */
export function decideCampaignStatus(
  totals: { recipients: number; sent: number; failed: number },
  remaining: number,
): CampaignStatus {
  if (remaining > 0) return 'partial'
  if (totals.recipients > 0 && totals.failed === totals.recipients) {
    return 'failed'
  }
  return 'completed'
}

export interface RecipientForSelection {
  id: string
  status: 'queued' | 'sending' | 'sent' | 'failed'
}

/**
 * 從收件人清單中選出這次呼叫要（重新）嘗試寄送的對象。
 *
 * status 不是 sent 的都算「還沒確認寄出」（包含 sending —— 卡在這個狀態
 * 通常代表上一次呼叫在寄送途中被中斷）。最多只取 limit 位，避免逼近
 * timeout；同一個 id 重複出現在清單中只算一次。
 */
export function selectRecipientsToProcess(
  recipients: RecipientForSelection[],
  limit: number,
): { toProcess: string[]; remaining: number } {
  const pendingIds: string[] = []
  const seen = new Set<string>()
  for (const r of recipients) {
    if (r.status === 'sent') continue
    if (seen.has(r.id)) continue
    seen.add(r.id)
    pendingIds.push(r.id)
  }
  const toProcess = pendingIds.slice(0, Math.max(0, limit))
  return { toProcess, remaining: pendingIds.length - toProcess.length }
}
