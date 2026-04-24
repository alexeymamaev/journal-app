// Builtin categories — v3 theme-primary.
// Each category = full preset of themes for bulk-add in onboarding step 2 or
// "+ Добавить" sheet. Categories are NOT persisted in profile state (the profile
// only holds a flat `themes` array). See v3-spec.md §3.
//
// `activeTypes` is a transitional alias of `themes` kept while v2 code paths
// still exist on this branch. To be removed once all references in app.js are
// migrated to `themes`.

window.CATEGORIES = [
  {
    key: 'gi',
    label: 'ЖКТ',
    icon: '🟢',
    description: 'пищеварение, стул, реакции на еду',
    themes: ['stool', 'food', 'reaction', 'mood', 'sleep', 'meds', 'symptom'],
    activeTypes: ['stool', 'food', 'reaction', 'mood', 'sleep', 'meds', 'symptom'],
  },
  {
    key: 'nutrition',
    label: 'Питание',
    icon: '🍏',
    description: 'еда, реакции, настроение',
    themes: ['food', 'reaction', 'mood', 'symptom'],
    activeTypes: ['food', 'reaction', 'mood', 'symptom'],
  },
  {
    key: 'homeo',
    label: 'Гомеопатия',
    icon: '🌿',
    description: 'для разговора с гомеопатом',
    themes: ['stool', 'food', 'reaction', 'mood', 'sleep', 'meds', 'symptom'],
    activeTypes: ['stool', 'food', 'reaction', 'mood', 'sleep', 'meds', 'symptom'],
  },
  {
    key: 'general',
    label: 'Общее',
    icon: '⚪',
    description: 'базовое самочувствие',
    themes: ['mood', 'sleep', 'food', 'symptom'],
    activeTypes: ['mood', 'sleep', 'food', 'symptom'],
  },
];

window.CATEGORY_BY_KEY = Object.fromEntries(window.CATEGORIES.map(c => [c.key, c]));
