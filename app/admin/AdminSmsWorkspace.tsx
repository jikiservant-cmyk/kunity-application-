'use client';

import { useMemo } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  History,
  ListChecks,
  Loader2,
  MessageSquareText,
  Phone,
  Plus,
  Send,
  ShieldCheck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { smsSegments } from '@/lib/sms-segments';
import styles from './AdminSmsWorkspace.module.css';

export type AdminSmsRecipientType = 'all' | 'single' | 'custom';

export type AdminSmsBundle = {
  credits: number;
  price: number;
  tag?: string;
};

export type AdminSmsHistoryLog = {
  id?: string | number;
  text?: string;
  recipients?: string;
  count?: number;
  cost?: number;
  date?: string;
  status?: string;
};

type RecipientOption = {
  id: AdminSmsRecipientType;
  title: string;
  description: string;
  Icon: LucideIcon;
};

type AdminSmsWorkspaceProps = {
  saccoName: string;
  membersCount: number;
  smsBalance: number;
  smsLowBalance: boolean;
  smsRate: number;
  smsHistory: AdminSmsHistoryLog[];
  bundles: AdminSmsBundle[];
  smsRecipientType: AdminSmsRecipientType;
  onRecipientTypeChange: (type: AdminSmsRecipientType) => void;
  singleRecipientPhone: string;
  onSingleRecipientPhoneChange: (phone: string) => void;
  customPhoneList: string;
  onCustomPhoneListChange: (phones: string) => void;
  smsMessageText: string;
  onSmsMessageTextChange: (message: string) => void;
  isSendingSms: boolean;
  onSendBroadcast: () => void;
  onBuyCredits: (bundle?: AdminSmsBundle) => void;
};

const RECIPIENT_OPTIONS: RecipientOption[] = [
  {
    id: 'all',
    title: 'All members',
    description: 'Reach your whole SACCO',
    Icon: Users,
  },
  {
    id: 'single',
    title: 'One member',
    description: 'Send to one phone number',
    Icon: Phone,
  },
  {
    id: 'custom',
    title: 'Custom list',
    description: 'Choose several numbers',
    Icon: ListChecks,
  },
];

const formatNumber = (value: number) =>
  Math.max(0, Number.isFinite(value) ? value : 0).toLocaleString('en-UG');

const formatMoney = (value: number) =>
  `UGX ${Math.max(0, Number.isFinite(value) ? value : 0).toLocaleString('en-UG')}`;

const parseCustomPhones = (value: string) =>
  value.split(/[\n,]+/).map((phone) => phone.trim()).filter(Boolean);

const dateParts = (value?: string) => {
  if (!value) return { key: 'unknown', label: 'Date unavailable' };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { key: 'unknown', label: 'Date unavailable' };

  const key = date.toDateString();
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const label = key === today.toDateString()
    ? 'Today'
    : key === yesterday.toDateString()
      ? 'Yesterday'
      : new Intl.DateTimeFormat('en-UG', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      }).format(date);

  return { key, label };
};

const formatTime = (value?: string) => {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-UG', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
};

const statusDetails = (rawStatus?: string) => {
  const status = String(rawStatus || '').trim();
  const normalized = status.toLowerCase();

  if (/fail|error|reject|undeliver/.test(normalized)) {
    return { label: 'Failed', tone: 'Failed' as const };
  }
  if (/sent|deliver|success|complete/.test(normalized)) {
    return { label: 'Sent', tone: 'Sent' as const };
  }
  if (!normalized || /queue|pending|processing/.test(normalized)) {
    return { label: 'Queued', tone: 'Queued' as const };
  }
  return {
    label: status.charAt(0).toUpperCase() + status.slice(1),
    tone: 'Queued' as const,
  };
};

export default function AdminSmsWorkspace({
  saccoName,
  membersCount,
  smsBalance,
  smsLowBalance,
  smsRate,
  smsHistory,
  bundles,
  smsRecipientType,
  onRecipientTypeChange,
  singleRecipientPhone,
  onSingleRecipientPhoneChange,
  customPhoneList,
  onCustomPhoneListChange,
  smsMessageText,
  onSmsMessageTextChange,
  isSendingSms,
  onSendBroadcast,
  onBuyCredits,
}: AdminSmsWorkspaceProps) {
  const customPhones = useMemo(() => parseCustomPhones(customPhoneList), [customPhoneList]);
  const historyGroups = useMemo(() => {
    const grouped = new Map<string, { label: string; entries: AdminSmsHistoryLog[] }>();
    const sortedHistory = [...smsHistory].sort((a, b) => {
      const timeA = a.date ? new Date(a.date).getTime() : 0;
      const timeB = b.date ? new Date(b.date).getTime() : 0;
      return (Number.isFinite(timeB) ? timeB : 0) - (Number.isFinite(timeA) ? timeA : 0);
    });

    for (const entry of sortedHistory) {
      const { key, label } = dateParts(entry.date);
      const group = grouped.get(key) || { label, entries: [] };
      group.entries.push(entry);
      grouped.set(key, group);
    }

    return Array.from(grouped.entries()).map(([key, group]) => ({ key, ...group }));
  }, [smsHistory]);

  const recipientEstimate = smsRecipientType === 'all'
    ? Math.max(0, membersCount)
    : smsRecipientType === 'single'
      ? (singleRecipientPhone.trim() ? 1 : 0)
      : customPhones.length;
  const trimmedMessage = smsMessageText.trim();
  const segmentCount = trimmedMessage ? smsSegments(trimmedMessage) : 0;
  const estimatedCredits = recipientEstimate * segmentCount;
  const estimatedCost = estimatedCredits * Math.max(0, Number(smsRate) || 0);
  const hasTooManyCustomRecipients = smsRecipientType === 'custom' && customPhones.length > 500;
  const canSend = Boolean(
    trimmedMessage &&
    recipientEstimate > 0 &&
    !isSendingSms &&
    !hasTooManyCustomRecipients
  );

  const hasEstimate = recipientEstimate > 0 && segmentCount > 0;
  const mayExceedBalance = hasEstimate && estimatedCredits > smsBalance;

  return (
    <div className={styles.smsPage}>
      <header className={styles.pageHeader}>
        <div className={styles.pageTitle}>
          <div className={styles.eyebrow}><span className={styles.eyebrowDot} /> MEMBER COMMUNICATIONS</div>
          <h1>Broadcast SMS</h1>
          <p>Send timely updates to your members and keep an eye on every message.</p>
        </div>

        <section className={styles.balanceCard} aria-label="SMS wallet balance">
          <div className={styles.balanceIcon}><Wallet size={21} strokeWidth={1.9} /></div>
          <div className={styles.balanceDetails}>
            <span className={styles.balanceLabel}>Available SMS balance</span>
            <strong>{formatNumber(smsBalance)} <small>credits</small></strong>
            <span className={styles.balanceRate}>{formatMoney(smsRate)} per SMS segment</span>
          </div>
          <div className={styles.balanceActions}>
            {smsLowBalance && <span className={styles.lowBalanceBadge}><AlertCircle size={12} /> Low balance</span>}
            <button type="button" className={styles.topUpButton} onClick={() => onBuyCredits()}>
              <Plus size={15} strokeWidth={2.2} /> Buy credits
            </button>
          </div>
        </section>
      </header>

      <div className={styles.workspaceGrid}>
        <section className={styles.composerPanel} aria-labelledby="sms-composer-title">
          <div className={styles.composerHeader}>
            <div className={styles.composerHeadingIcon}><MessageSquareText size={19} /></div>
            <div className={styles.composerHeadingText}>
              <span className={styles.panelEyebrow}>MESSAGE COMPOSER</span>
              <h2 id="sms-composer-title">New broadcast</h2>
              <p>Choose an audience, write your message, then send.</p>
            </div>
            <span className={styles.readyBadge}><span /> {isSendingSms ? 'Sending' : 'Ready to send'}</span>
          </div>

          <div className={styles.composerBody}>
            <section className={styles.formSection} aria-labelledby="sms-audience-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="sms-audience-title">Choose recipients</h3>
                  <p>Select who should receive this message.</p>
                </div>
                {recipientEstimate > 0 && (
                  <span className={styles.recipientCount}>{formatNumber(recipientEstimate)} {recipientEstimate === 1 ? 'recipient' : 'recipients'}</span>
                )}
              </div>

              <div className={styles.recipientGrid}>
                {RECIPIENT_OPTIONS.map(({ id, title, description, Icon }) => {
                  const isSelected = smsRecipientType === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`${styles.recipientOption} ${isSelected ? styles.recipientOptionSelected : ''}`}
                      onClick={() => onRecipientTypeChange(id)}
                      aria-pressed={isSelected}
                      disabled={isSendingSms}
                    >
                      <span className={styles.recipientIcon}><Icon size={17} strokeWidth={1.9} /></span>
                      <span className={styles.recipientCopy}>
                        <strong>{title}</strong>
                        <small>{id === 'all' ? `${description} · ${formatNumber(membersCount)}` : description}</small>
                      </span>
                      <span className={`${styles.radioMark} ${isSelected ? styles.radioMarkSelected : ''}`} aria-hidden="true">
                        {isSelected && <CheckCircle2 size={15} />}
                      </span>
                    </button>
                  );
                })}
              </div>

              {smsRecipientType === 'all' && (
                <div className={styles.audienceSummary}>
                  <span className={styles.summaryIcon}><Users size={17} /></span>
                  <span className={styles.summaryCopy}>
                    <strong>All SACCO members</strong>
                    <small>Up to {formatNumber(membersCount)} member records. Invalid phone numbers are skipped before dispatch.</small>
                  </span>
                  <span className={styles.summaryPill}>{formatNumber(membersCount)} total</span>
                </div>
              )}

              {smsRecipientType === 'single' && (
                <div className={styles.conditionalField}>
                  <label htmlFor="sms-single-phone">Member phone number</label>
                  <div className={styles.inputWithIcon}>
                    <Phone size={16} aria-hidden="true" />
                    <input
                      id="sms-single-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="e.g. 0772 123 456"
                      value={singleRecipientPhone}
                      onChange={(event) => onSingleRecipientPhoneChange(event.target.value)}
                      disabled={isSendingSms}
                    />
                  </div>
                  <small>Use a phone number already registered with this SACCO.</small>
                </div>
              )}

              {smsRecipientType === 'custom' && (
                <div className={styles.conditionalField}>
                  <label htmlFor="sms-custom-phones">Custom member numbers</label>
                  <textarea
                    id="sms-custom-phones"
                    rows={3}
                    placeholder={'0772 123 456, 0702 345 678\n0755 111 222'}
                    value={customPhoneList}
                    onChange={(event) => onCustomPhoneListChange(event.target.value)}
                    disabled={isSendingSms}
                    aria-describedby="sms-custom-help"
                  />
                  <div className={styles.fieldFooter}>
                    <small id="sms-custom-help">Separate numbers with commas or new lines. Numbers must belong to this SACCO.</small>
                    <span>{formatNumber(customPhones.length)} / 500</span>
                  </div>
                  {hasTooManyCustomRecipients && (
                    <span className={styles.fieldError}>A broadcast can include up to 500 custom numbers.</span>
                  )}
                </div>
              )}
            </section>

            <section className={styles.formSection} aria-labelledby="sms-message-title">
              <div className={styles.sectionHeading}>
                <div>
                  <h3 id="sms-message-title">Message content</h3>
                  <p>Keep it clear and easy to read on a phone.</p>
                </div>
                <span className={`${styles.characterCount} ${smsMessageText.length >= 900 ? styles.characterCountNearLimit : ''}`}>
                  {formatNumber(smsMessageText.length)} <span>/ 1,000</span>
                </span>
              </div>
              <textarea
                id="sms-message-body"
                className={styles.messageTextarea}
                rows={6}
                maxLength={1000}
                placeholder={`Hello from ${saccoName}, we have an important update to share with you...`}
                value={smsMessageText}
                onChange={(event) => onSmsMessageTextChange(event.target.value)}
                disabled={isSendingSms}
                aria-label="SMS message content"
              />
              <div className={styles.messageMeta}>
                <span>SMS segments are calculated using message encoding.</span>
                <span className={`${styles.segmentBadge} ${segmentCount > 1 ? styles.segmentBadgeMulti : ''}`}>
                  {segmentCount || '—'} {segmentCount === 1 ? 'segment' : 'segments'}
                </span>
              </div>
            </section>

            <section className={styles.estimatePanel} aria-label="Broadcast estimate">
              <div className={styles.estimateCell}>
                <span>Recipients</span>
                <strong>{hasEstimate ? `~${formatNumber(recipientEstimate)}` : '—'}</strong>
              </div>
              <div className={styles.estimateCell}>
                <span>Segments each</span>
                <strong>{segmentCount || '—'}</strong>
              </div>
              <div className={`${styles.estimateCell} ${styles.estimateCellEmphasis}`}>
                <span>Estimated usage</span>
                <strong>{hasEstimate ? `~${formatNumber(estimatedCredits)} credits` : '—'}</strong>
                {hasEstimate && <small>{formatMoney(estimatedCost)} estimated</small>}
              </div>
            </section>

            {mayExceedBalance && (
              <div className={styles.balanceNotice} role="status">
                <AlertCircle size={16} />
                <span>
                  This estimate is higher than your current balance. Final recipient counts and available funds are checked before dispatch.
                </span>
              </div>
            )}

            <div className={styles.composerFooter}>
              <span className={styles.sendFootnote}><ShieldCheck size={15} /> Messages are charged per SMS segment.</span>
              <button
                type="button"
                className={styles.sendButton}
                onClick={onSendBroadcast}
                disabled={!canSend}
                aria-busy={isSendingSms}
              >
                {isSendingSms ? <Loader2 size={17} className={styles.spinning} /> : <Send size={16} />}
                {isSendingSms ? 'Sending broadcast…' : 'Send broadcast'}
              </button>
            </div>
          </div>
        </section>

        <aside className={styles.sidebar} aria-label="SMS balance and recent activity">
          <section className={styles.walletPanel} aria-labelledby="sms-top-up-title">
            <div className={styles.asideHeading}>
              <span className={styles.asideHeadingIcon}><Wallet size={17} /></span>
              <div>
                <h2 id="sms-top-up-title">Top up credits</h2>
                <p>Choose a bundle and pay with Mobile Money.</p>
              </div>
            </div>
            <div className={styles.bundleGrid}>
              {bundles.map((bundle) => (
                <button
                  type="button"
                  key={bundle.credits}
                  className={`${styles.bundleOption} ${bundle.tag?.toLowerCase() === 'popular' ? styles.bundleOptionPopular : ''}`}
                  onClick={() => onBuyCredits(bundle)}
                  aria-label={`Buy ${formatNumber(bundle.credits)} SMS credits for ${formatMoney(bundle.price)}`}
                >
                  <span className={styles.bundleTag}>{bundle.tag || 'Bundle'}</span>
                  <strong>{formatNumber(bundle.credits)} <small>SMS</small></strong>
                  <span className={styles.bundlePrice}>{formatMoney(bundle.price)}</span>
                </button>
              ))}
            </div>
            <p className={styles.walletFootnote}><ShieldCheck size={14} /> A secure Mobile Money PIN prompt will be sent to your phone.</p>
          </section>

          <section className={styles.historyPanel} aria-labelledby="sms-history-title">
            <div className={styles.historyHeader}>
              <div className={styles.asideHeading}>
                <span className={`${styles.asideHeadingIcon} ${styles.historyHeadingIcon}`}><History size={17} /></span>
                <div>
                  <h2 id="sms-history-title">Recent SMS activity</h2>
                  <p>Your latest messages and delivery status.</p>
                </div>
              </div>
              <span className={styles.historyCount}>{formatNumber(smsHistory.length)}</span>
            </div>

            {historyGroups.length === 0 ? (
              <div className={styles.historyEmpty}>
                <span className={styles.emptyIcon}><MessageSquareText size={21} /></span>
                <strong>No messages yet</strong>
                <p>Sent broadcasts will appear here with their latest status.</p>
              </div>
            ) : (
              <div className={styles.historyList}>
                {historyGroups.map((group) => (
                  <div className={styles.historyGroup} key={group.key}>
                    <div className={styles.historyDate}>
                      <span>{group.label}</span>
                      <span>{group.entries.length} {group.entries.length === 1 ? 'message' : 'messages'}</span>
                    </div>
                    {group.entries.map((entry, index) => {
                      const status = statusDetails(entry.status);
                      const message = String(entry.text || '').trim();
                      const count = Math.max(1, Number(entry.count) || 1);
                      const recipientsLabel = count > 1
                        ? `To ${formatNumber(count)} members`
                        : entry.recipients
                          ? `To ${entry.recipients}`
                          : 'Recipient unavailable';
                      const credits = Number(entry.cost) || 0;
                      const key = entry.id ?? `${entry.date || 'message'}-${index}`;

                      return (
                        <article className={styles.historyItem} key={key}>
                          <div className={styles.historyItemTop}>
                            <span className={styles.historyTime}><Clock3 size={12} /> {formatTime(entry.date) || 'Recently'}</span>
                            <span className={`${styles.historyStatus} ${styles[`historyStatus${status.tone}`]}`}>
                              <span /> {status.label}
                            </span>
                          </div>
                          <p className={styles.historyMessage} title={message || 'No message content'}>
                            {message || 'No message content'}
                          </p>
                          <div className={styles.historyItemFooter}>
                            <span>{recipientsLabel}</span>
                            {credits > 0 && <span>{formatNumber(credits)} {credits === 1 ? 'credit' : 'credits'}</span>}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
