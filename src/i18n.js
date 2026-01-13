// Internationalization strings
const translations = {
  en: {
    protectedAreas: 'protected areas',
    protectedAreasShort: 'protected',
    vesselCrossings: 'vessel crossings',
    vesselCrossingsShort: 'crossings',
    satellite: 'satellite imagery',
    satelliteShort: 'satellite',
    dataSource: 'data: Global Fishing Watch',
    dataSourceShort: 'data: GFW',
    vessel: 'vessel',
    mmsi: 'mmsi',
    type: 'type',
    flag: 'flag',
    duration: 'duration',
    days: 'days',
    hours: 'hours',
    year: 'year',
    firstSeen: 'first seen',
    lastSeen: 'last seen',
    unknown: 'unknown',
    protectedArea: 'protected area',
    selectPlace: 'select a place of interest',
    selectCategory: 'select vessel category',
    allVessels: 'all vessels',
    multiYear: 'multiple years',
    multiYearShort: 'multi',
    sectionVessel: 'vessel presence',
    sectionLayers: 'additional layers',
    // Vessel types
    vesselType_BUNKER: 'bunker',
    vesselType_CARGO: 'cargo',
    vesselType_CARRIER: 'carrier',
    vesselType_DISCREPANCY: 'discrepancy',
    vesselType_FISHING: 'fishing',
    vesselType_GEAR: 'gear',
    vesselType_OTHER: 'other',
    vesselType_PASSENGER: 'passenger',
    vesselType_SEISMIC_VESSEL: 'seismic',
    hoursShort: 'h',
    more: 'more',
  },
  ru: {
    protectedAreas: 'охраняемые территории',
    protectedAreasShort: 'охраняемые',
    vesselCrossings: 'пересечения судов',
    vesselCrossingsShort: 'пересечения',
    satellite: 'спутниковые снимки',
    satelliteShort: 'спутник',
    dataSource: 'данные: Global Fishing Watch',
    dataSourceShort: 'данные: GFW',
    vessel: 'судно',
    mmsi: 'mmsi',
    type: 'тип',
    flag: 'флаг',
    duration: 'длительность',
    days: 'дней',
    hours: 'часов',
    year: 'год',
    firstSeen: 'первое обнаружение',
    lastSeen: 'последнее обнаружение',
    unknown: 'неизвестно',
    protectedArea: 'охраняемая территория',
    selectPlace: 'выберите место',
    selectCategory: 'выберите категорию судов',
    allVessels: 'все суда',
    multiYear: 'несколько лет',
    multiYearShort: 'неск.',
    sectionVessel: 'присутствие судов',
    sectionLayers: 'дополнительные слои',
    // Vessel types
    vesselType_BUNKER: 'бункеровщик',
    vesselType_CARGO: 'грузовое',
    vesselType_CARRIER: 'перевозчик',
    vesselType_DISCREPANCY: 'несоответствие',
    vesselType_FISHING: 'рыболовное',
    vesselType_GEAR: 'оборудование',
    vesselType_OTHER: 'другое',
    vesselType_PASSENGER: 'пассажирское',
    vesselType_SEISMIC_VESSEL: 'сейсморазведка',
    hoursShort: 'ч',
    more: 'ещё',
  }
}

let currentLang = 'ru'

export const t = (key) => translations[currentLang][key]

export const tVesselType = (type) => {
  if (!type) return t('unknown')
  const key = `vesselType_${type}`
  return translations[currentLang][key] || type
}

export const getLang = () => currentLang

export const setLang = (lang) => {
  currentLang = lang
}

export const toggleLang = () => {
  currentLang = currentLang === 'ru' ? 'en' : 'ru'
  return currentLang
}
