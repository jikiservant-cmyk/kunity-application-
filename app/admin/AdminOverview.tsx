'use client';

import { useMemo, type ReactNode } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  ClipboardCheck,
  Eye,
  EyeOff,
  Plus,
  Send,
  Users,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import styles from './AdminConsole.module.css';

export type AdminConsoleTab = 'overview' | 'approvals' | 'members' | 'loans' | 'sms' | 'tenant';

type AdminStats = {
  totalMembers?: number;
  activeMembers?: number;
  pendingMembers?: number;
  totalLiquidity?: number;
  avgSavingsPerMember?: number;
  activeLoansCount?: number;
  pendingLoansCount?: number;
  pendingLoansAmount?: number;
  totalLoansDisbursedAmount?: number;
};

type AdminActivity = {
  id: string;
  description?: string;
  type?: string;
  amount?: number | string;
  memberName?: string;
  createdAt?: string;
};

type AdminOverviewProps = {
  saccoName: string;
  greeting: string;
  stats: AdminStats;
  pendingMemberCount: number;
  recentTransactions: AdminActivity[];
  savingsProductCount: number;
  smsBalance: number;
  smsLowBalance: boolean;
  activitySearch: string;
  hideBalances: boolean;
  onToggleBalances: () => void;
  onNavigate: (tab: AdminConsoleTab) => void;
};

const numberValue = (value: number | string | undefined) => {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
};

const compactMoney = (value: number | string | undefined) => {
  const amount = numberValue(value);
  return `UGX ${new Intl.NumberFormat('en-UG', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(amount)}`;
};

const chartDate = (value: string | undefined, index: number) => {
  if (!value) return `Entry ${index + 1}`;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return `Entry ${index + 1}`;
  return new Intl.DateTimeFormat('en-UG', { day: 'numeric', month: 'short' }).format(date);
};

const activityDate = (value: string | undefined) => {
  if (!value) return 'Recently';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Recently';
  const time = new Intl.DateTimeFormat('en-UG', { hour: 'numeric', minute: '2-digit' }).format(date);
  const isToday = date.toDateString() === new Date().toDateString();
  return isToday ? `Today · ${time}` : new Intl.DateTimeFormat('en-UG', { day: 'numeric', month: 'short' }).format(date);
};

const initials = (name: string | undefined) => {
  const parts = (name || 'K-Unity').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'KU';
};

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone,
  action,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone: 'blue' | 'green' | 'violet' | 'amber';
  action?: ReactNode;
}) {
  return (
    <article className={styles.metricCard}>
      <div className={styles.metricCardTop}>
        <span className={styles.metricLabel}>{label}</span>
        <span className={`${styles.metricIcon} ${styles[`metricIcon${tone[0].toUpperCase()}${tone.slice(1)}`]}`}>
          <Icon size={18} strokeWidth={1.9} />
        </span>
      </div>
      <div className={styles.metricValueRow}>
        <div className={styles.metricValue} title={value}>{value}</div>
        {action}
      </div>
      <div className={styles.metricDetail}>{detail}</div>
    </article>
  );
}

export default function AdminOverview({
  saccoName,
  greeting,
  stats,
  pendingMemberCount,
  recentTransactions,
  savingsProductCount,
  smsBalance,
  smsLowBalance,
  activitySearch,
  hideBalances,
  onToggleBalances,
  onNavigate,
}: AdminOverviewProps) {
  const transactions = recentTransactions;
  const chartData = useMemo(() => transactions.slice(0, 12).reverse().map((transaction, index) => ({
    label: chartDate(transaction.createdAt, index),
    amount: numberValue(transaction.amount),
  })), [transactions]);

  const filteredActivity = useMemo(() => {
    const query = activitySearch.trim().toLocaleLowerCase();
    return transactions.filter((transaction) => !query || [
      transaction.description,
      transaction.memberName,
      transaction.type,
      transaction.amount,
    ].join(' ').toLocaleLowerCase().includes(query)).slice(0, 5);
  }, [activitySearch, transactions]);

  const today = new Intl.DateTimeFormat('en-UG', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date());
  const pendingLoansCount = numberValue(stats.pendingLoansCount);
  const pendingItems = pendingMemberCount + pendingLoansCount;

  return (
    <>
      <section className={styles.welcome}>
        <div>
          <div className={styles.dateLabel}>{today}</div>
          <h1>{greeting}.</h1>
          <p>Here&apos;s {saccoName} at a glance.</p>
        </div>
        <button className={styles.primaryButton} onClick={() => onNavigate('tenant')}>
          <Plus size={16} />
          Invite a member
        </button>
      </section>

      <section className={styles.metricsGrid} aria-label="Workspace summary">
        <MetricCard
          icon={Users}
          label="Total members"
          value={numberValue(stats.totalMembers).toLocaleString('en-UG')}
          detail={`${numberValue(stats.activeMembers).toLocaleString('en-UG')} active · ${numberValue(stats.pendingMembers).toLocaleString('en-UG')} awaiting activation`}
          tone="blue"
        />
        <MetricCard
          icon={Wallet}
          label="Total savings"
          value={hideBalances ? '••••••••' : compactMoney(stats.totalLiquidity)}
          detail="Combined member account balances"
          tone="green"
          action={(
            <button
              type="button"
              className={styles.balanceToggle}
              onClick={onToggleBalances}
              aria-label={hideBalances ? 'Show savings balance' : 'Hide savings balance'}
              title={hideBalances ? 'Show balance' : 'Hide balance'}
            >
              {hideBalances ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          )}
        />
        <MetricCard
          icon={Activity}
          label="Active loans"
          value={numberValue(stats.activeLoansCount).toLocaleString('en-UG')}
          detail={`${compactMoney(stats.totalLoansDisbursedAmount)} disbursed`}
          tone="violet"
        />
        <MetricCard
          icon={ClipboardCheck}
          label="Needs attention"
          value={pendingItems.toLocaleString('en-UG')}
          detail={`${pendingMemberCount} onboarding · ${pendingLoansCount} loan reviews`}
          tone="amber"
          action={pendingItems > 0 ? (
            <button
              type="button"
              className={styles.inlineAction}
              onClick={() => onNavigate(pendingLoansCount > 0 ? 'loans' : 'approvals')}
              aria-label="Review pending items"
              title="Review pending items"
            >
              <ArrowRight size={15} />
            </button>
          ) : undefined}
        />
      </section>

      {smsLowBalance && (
        <button className={styles.lowBalanceNotice} onClick={() => onNavigate('sms')}>
          <span className={styles.noticeIcon}><AlertCircle size={17} /></span>
          <span><strong>SMS credits are running low.</strong> Top up to keep member updates flowing.</span>
          <ArrowRight size={16} />
        </button>
      )}

      <section className={styles.dashboardGrid}>
        <article className={`${styles.panel} ${styles.financialPanel}`}>
          <div className={styles.panelHeading}>
            <div>
              <h2>Financial overview</h2>
              <p>Amounts from the latest journal entries</p>
            </div>
            <span className={styles.entryCount}>{chartData.length} latest entries</span>
          </div>

          {chartData.length > 0 ? (
            <div className={styles.chartWrap} role="img" aria-label="Recent journal entry amounts">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 12, right: 8, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="kunityAdminArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#1677ff" stopOpacity={0.2} />
                      <stop offset="100%" stopColor="#1677ff" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#edf0f5" vertical={false} />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#8995a8', fontSize: 10 }} minTickGap={20} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#8995a8', fontSize: 10 }} tickFormatter={(value) => new Intl.NumberFormat('en-UG', { notation: 'compact', maximumFractionDigits: 0 }).format(value)} width={42} />
                  <Tooltip
                    formatter={(value) => [`UGX ${numberValue(value as number).toLocaleString('en-UG')}`, 'Amount']}
                    contentStyle={{ border: '1px solid #e5eaf2', borderRadius: 9, boxShadow: '0 8px 24px rgba(24,34,53,.1)', fontSize: 11 }}
                    labelStyle={{ color: '#68758a', marginBottom: 4 }}
                  />
                  <Area type="monotone" dataKey="amount" stroke="#1677ff" strokeWidth={2.5} fill="url(#kunityAdminArea)" activeDot={{ r: 4, fill: '#1677ff', stroke: '#fff', strokeWidth: 2 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className={styles.chartEmpty}>
              <Activity size={22} />
              <span>Ledger activity will appear here as transactions are recorded.</span>
            </div>
          )}

          <div className={styles.panelFooter}>
            <div>
              <span>Savings portfolio</span>
              <strong>{hideBalances ? '••••••••' : compactMoney(stats.totalLiquidity)}</strong>
            </div>
            <div>
              <span>Active savings plans</span>
              <strong>{savingsProductCount.toLocaleString('en-UG')}</strong>
            </div>
          </div>
        </article>

        <article className={`${styles.panel} ${styles.activityPanel}`}>
          <div className={styles.panelHeading}>
            <div>
              <h2>Recent activity</h2>
              <p>Latest SACCO updates</p>
            </div>
            <button className={styles.smsBadge} onClick={() => onNavigate('sms')} title="Open SMS tools">
              <Send size={13} />
              {smsBalance.toLocaleString('en-UG')} SMS
            </button>
          </div>

          <div className={styles.activityList}>
            {filteredActivity.length > 0 ? filteredActivity.map((transaction) => {
              const isDeposit = (transaction.type || '').toLowerCase().includes('deposit');
              const isOutflow = ['withdrawal', 'disbursement', 'debit'].some((word) => (transaction.type || '').toLowerCase().includes(word));
              const amountTone = isDeposit ? styles.activityPositive : isOutflow ? styles.activityNegative : '';
              const AmountIcon = isOutflow ? ArrowUpRight : ArrowDownLeft;
              return (
                <div key={transaction.id} className={styles.activityItem}>
                  <div className={styles.activityAvatar}>{initials(transaction.memberName)}</div>
                  <div className={styles.activityPerson}>
                    <strong>{transaction.memberName || 'Cooperative account'}</strong>
                    <span>{transaction.description || transaction.type || 'Account activity'}</span>
                  </div>
                  <div className={styles.activityAmount}>
                    <strong className={amountTone}>
                      <AmountIcon size={12} />
                      {compactMoney(transaction.amount)}
                    </strong>
                    <span>{activityDate(transaction.createdAt)}</span>
                  </div>
                </div>
              );
            }) : (
              <div className={styles.activityEmpty}>
                {activitySearch.trim() ? 'No activity matches your search.' : 'No recent activity to show yet.'}
              </div>
            )}
          </div>

          <div className={styles.activityFootnote}>
            Showing {filteredActivity.length} of {transactions.length} recent records
          </div>
        </article>
      </section>

      <footer className={styles.dashboardFooter}>
        <span>© {new Date().getFullYear()} {saccoName} Admin</span>
        <span><i /> Workspace active</span>
      </footer>
    </>
  );
}
