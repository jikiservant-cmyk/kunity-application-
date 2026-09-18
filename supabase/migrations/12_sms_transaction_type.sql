ALTER TABLE public.sms_messages ADD COLUMN IF NOT EXISTS transaction_type text NOT NULL DEFAULT 'debit';
