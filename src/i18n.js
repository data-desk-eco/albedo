/**
 * Internationalization module
 * Loads translations from remote JSON files specified in manifest
 */

let translations = {}
let currentLang = 'en'
let availableLangs = ['en']
let dataUrl = ''

/**
 * Initialize i18n with manifest configuration
 * @param {Object} manifest - The app manifest
 * @param {string} baseUrl - Base URL for data files
 */
export async function initI18n(manifest, baseUrl) {
  dataUrl = baseUrl
  availableLangs = manifest.ui?.availableLangs || ['en']

  // Language priority: localStorage > browser preference > manifest default > 'en'
  const browserLang = navigator.languages
    ?.map(l => l.split('-')[0])
    .find(l => availableLangs.includes(l))
  currentLang = localStorage.getItem('lang') || browserLang || manifest.ui?.defaultLang || 'en'

  // Validate current lang is available
  if (!availableLangs.includes(currentLang)) {
    currentLang = availableLangs[0]
  }

  // Load the current language
  await loadLanguage(currentLang)
}

/**
 * Load a language file
 */
async function loadLanguage(lang) {
  try {
    const response = await fetch(`${dataUrl}i18n/${lang}.json`)
    if (!response.ok) throw new Error(`Failed to load ${lang}.json`)
    translations[lang] = await response.json()
  } catch (err) {
    console.error(`Failed to load language ${lang}:`, err)
    // Fallback: try to load English
    if (lang !== 'en' && !translations['en']) {
      try {
        const response = await fetch(`${dataUrl}i18n/en.json`)
        translations['en'] = await response.json()
        currentLang = 'en'
      } catch {
        console.error('Failed to load fallback English translations')
      }
    }
  }
}

/**
 * Get translation for a key
 */
export function t(key) {
  return translations[currentLang]?.[key] || key
}

/**
 * Get vessel type translation
 */
export function tVesselType(type) {
  if (!type) return t('unknown')
  return translations[currentLang]?.vesselTypes?.[type] || type
}

/**
 * Get current language
 */
export function getLang() {
  return currentLang
}

/**
 * Set language
 */
export async function setLang(lang) {
  if (!availableLangs.includes(lang)) return currentLang

  // Load language if not already loaded
  if (!translations[lang]) {
    await loadLanguage(lang)
  }

  currentLang = lang
  localStorage.setItem('lang', lang)
  return currentLang
}

/**
 * Toggle between available languages
 */
export async function toggleLang() {
  const currentIndex = availableLangs.indexOf(currentLang)
  const nextIndex = (currentIndex + 1) % availableLangs.length
  return await setLang(availableLangs[nextIndex])
}

/**
 * Get available languages
 */
export function getAvailableLangs() {
  return availableLangs
}

/**
 * Get localized string from an object with lang keys
 * @param {Object} obj - Object like { en: "Hello", ru: "Привет" }
 * @param {string} fallback - Fallback if no translation found
 */
export function localize(obj, fallback = '') {
  if (!obj) return fallback
  return obj[currentLang] || obj['en'] || Object.values(obj)[0] || fallback
}
