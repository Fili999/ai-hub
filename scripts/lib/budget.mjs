import { tFor } from './i18n.mjs';

// Token savings level (optional): Settings → "Token savings" (settings.json, tokens.savingLevel).
// Off by default: standard operation (quality first, savings only on evident waste).
// Each level adds rules cumulatively. No level skips criteria, tests, quality gates, source verification, or security checks:
// savings focus on workflow efficiency, never compromising result quality.

export const SAVING_LEVELS = ['off', 'light', 'medium', 'max'];

export const SAVING_LABELS = { off: 'Off (default)', light: 'Light', medium: 'Medium', max: 'Maximum' };

const RULE_COUNTS = {
  off: 0,
  light: 3,
  medium: 3,
  max: 3,
};

/** Rules applicable for a savings level (cumulative). Unknown value defaults to "off". */
export function savingRules(level, t = tFor()) {
  const i = SAVING_LEVELS.indexOf(level);
  if (i <= 0) return { level: 'off', label: t('budget.level.off'), rules: [] };
  const rules = [];
  for (let idx = 1; idx <= i; idx++) {
    const l = SAVING_LEVELS[idx];
    for (let rIdx = 0; rIdx < RULE_COUNTS[l]; rIdx++) {
      rules.push(t(`budget.rule.${l}.${rIdx}`));
    }
  }
  return { level, label: t(`budget.level.${level}`), rules: [...rules, t('budget.always')] };
}
