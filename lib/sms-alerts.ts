// Below this many SMS credits the admin dashboard warns that member SMS will fail.
// Automatic SMS (welcome, deposit receipts) are dropped when the wallet cannot cover them,
// so the warning has to come before the balance runs out.
export const LOW_SMS_BALANCE_CREDITS = 50;
