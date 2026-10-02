import { enUS, es, ko, ptBR, type Locale } from "date-fns/locale";

// The UI language is fixed per deployment (NEXT_PUBLIC_APP_LOCALE, see src/i18n/request.ts).
// Dates/numbers must follow it too, or Portuguese screens show "about 11 hours" / "Oct 1".
const APP_LOCALE = process.env.NEXT_PUBLIC_APP_LOCALE || "en";

/** date-fns locale for format()/formatDistanceToNow(). */
export const DATE_FNS_LOCALE: Locale = ({ pt: ptBR, es, ko, en: enUS } as Record<string, Locale>)[APP_LOCALE] ?? enUS;

/** BCP-47 tag for Intl / toLocaleDateString(). */
export const INTL_LOCALE: string = ({ pt: "pt-BR", es: "es", ko: "ko-KR", en: "en-US" } as Record<string, string>)[APP_LOCALE] ?? "en-US";
