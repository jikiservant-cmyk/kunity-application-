-- ============================================================================
-- 26: Remove kunity.handle_payment_success_unlock (and its trigger).
--
-- Why: the function activated EVERY account and member_savings row of a member
-- whenever ANY payment reached 'success' (deposits included). A pending member
-- could skip the activation fee with a small deposit. It also compared the
-- payment_status enum with the text 'successful', which is not a valid enum
-- value, so payment status updates could raise errors. It was not in the
-- repository.
--
-- Activation is now handled only by:
--   * the activation branch of process_najiki_webhook (accounts + savings), and
--   * trg_activate_member_on_activation_payment (migration 25), which moves the
--     member from 'pending' to 'active' for qualifying activation payments.
--
-- CASCADE removes every trigger that uses the function.
-- ============================================================================

DROP FUNCTION IF EXISTS kunity.handle_payment_success_unlock() CASCADE;
