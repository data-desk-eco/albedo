/**
 * Internationalization — loads translations from remote JSON
 */

let translations = {}
let currentLang = 'en'
let availableLangs = ['en']
let dataUrl = ''

export async function initI18n(manifest, baseUrl) {
  dataUrl = baseUrl
  availableLangs = manifest.ui?.availableLangs || ['en']

  const browserLang = navigator.languages
    ?.map(l => l.split('-')[0])
    .find(l => availableLangs.includes(l))
  currentLang = localStorage.getItem('lang') || browserLang || manifest.ui?.defaultLang

  if (!availableLangs.includes(currentLang)) currentLang = availableLangs[0]
  await loadLanguage(currentLang)
}

async function loadLanguage(lang) {
  try {
    const resp = await fetch(`${dataUrl}i18n/${lang}.json`)
    if (!resp.ok) throw new Error(`Failed to load ${lang}.json`)
    translations[lang] = await resp.json()
  } catch (err) {
    console.error(`Failed to load language ${lang}:`, err)
    if (lang !== 'en' && !translations['en']) {
      try {
        translations['en'] = await (await fetch(`${dataUrl}i18n/en.json`)).json()
        currentLang = 'en'
      } catch { /* no fallback available */ }
    }
  }
}

export function t(key) {
  return translations[currentLang]?.[key] || key
}

export function tVesselType(type) {
  if (!type) return t('unknown')
  return translations[currentLang]?.vesselTypes?.[type] || type
}

export function getLang() {
  return currentLang
}

export async function setLang(lang) {
  if (!availableLangs.includes(lang)) return currentLang
  if (!translations[lang]) await loadLanguage(lang)
  currentLang = lang
  localStorage.setItem('lang', lang)
  return currentLang
}

export async function toggleLang() {
  const next = (availableLangs.indexOf(currentLang) + 1) % availableLangs.length
  return setLang(availableLangs[next])
}

export function localize(obj, fallback = '') {
  if (!obj) return fallback
  return obj[currentLang] || obj['en'] || Object.values(obj)[0] || fallback
}
