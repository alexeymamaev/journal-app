// Builtin profiles. Each profile = list of active type-keys + default main tile order + report template id (used later).

window.PROFILES = [
  {
    key: 'gi',
    label: 'ЖКТ',
    icon: '🟢',
    description: 'пищеварение, стул, реакции на еду',
    activeTypes: ['stool', 'food', 'reaction', 'mood', 'sleep', 'meds', 'symptom'],
    defaultMainTiles: ['stool', 'food', 'reaction', 'mood', 'sleep', 'meds', 'symptom'],
    reportTemplate: 'gi_report',
  },
  {
    key: 'nutrition',
    label: 'Питание',
    icon: '🍏',
    description: 'еда, реакции, настроение',
    activeTypes: ['food', 'reaction', 'mood', 'symptom'],
    defaultMainTiles: ['food', 'reaction', 'mood', 'symptom'],
    reportTemplate: 'nutrition_report',
  },
  {
    key: 'homeo',
    label: 'Гомео',
    icon: '🌿',
    description: 'для разговора с гомеопатом',
    activeTypes: ['stool', 'food', 'reaction', 'mood', 'sleep', 'meds', 'symptom'],
    defaultMainTiles: ['symptom', 'mood', 'sleep', 'stool', 'food', 'reaction', 'meds'],
    reportTemplate: 'homeo_report',
  },
  {
    key: 'general',
    label: 'Общее',
    icon: '⚪',
    description: 'базовое самочувствие',
    activeTypes: ['mood', 'sleep', 'food', 'symptom'],
    defaultMainTiles: ['mood', 'sleep', 'food', 'symptom'],
    reportTemplate: 'general_report',
  },
];

window.PROFILE_BY_KEY = Object.fromEntries(window.PROFILES.map(p => [p.key, p]));
