// Builtin event types — fields-schema registry.
// Shape: { key, label, icon, description, fields: [{ key, label, kind, required, options?, placeholder? }] }
// kinds: 'single' | 'multi' | 'text'

window.TYPES = [
  {
    key: 'stool',
    label: 'Стул',
    icon: '💩',
    description: 'норма · объём · цвет · примеси',
    fields: [
      {
        key: 'character', label: 'Как сегодня', kind: 'single', required: true,
        options: [
          { key: 'norm', label: 'норма' },
          { key: 'constipation', label: 'запор' },
          { key: 'diarrhea', label: 'диарея' },
        ],
      },
      {
        key: 'volume', label: 'Объём', kind: 'single', required: false,
        options: [
          { key: 'low', label: 'мало' },
          { key: 'avg', label: 'норма' },
          { key: 'high', label: 'много' },
        ],
      },
      {
        key: 'colors', label: 'Цвет', kind: 'multi', required: false,
        options: [
          { key: 'norm', label: 'норма' },
          { key: 'yellow', label: 'жёлтый' },
          { key: 'green', label: 'зелёный' },
          { key: 'black', label: 'чёрный' },
          { key: 'blood', label: 'с кровью' },
        ],
      },
      {
        key: 'impurities', label: 'Примеси', kind: 'multi', required: false,
        options: [
          { key: 'mucus', label: 'слизь' },
          { key: 'undigested', label: 'непереваренное' },
          { key: 'foam', label: 'пена' },
        ],
      },
      { key: 'note', label: 'Заметка', kind: 'text', required: false, placeholder: 'по желанию' },
    ],
  },

  {
    key: 'food',
    label: 'Еда',
    icon: '🍽',
    description: 'что ел · сколько · реакция',
    fields: [
      {
        key: 'kind', label: 'Что', kind: 'single', required: true,
        options: [
          { key: 'meal', label: 'приём пищи' },
          { key: 'snack', label: 'перекус' },
          { key: 'drink', label: 'питьё' },
        ],
      },
      {
        key: 'volume', label: 'Сколько', kind: 'single', required: false,
        options: [
          { key: 'little', label: 'мало' },
          { key: 'normal', label: 'нормально' },
          { key: 'much', label: 'много' },
        ],
      },
      { key: 'note', label: 'Что именно', kind: 'text', required: false, placeholder: 'каша, фрукт, вода…' },
    ],
  },

  {
    key: 'reaction',
    label: 'Реакция',
    icon: '⚡',
    description: 'что изменилось после еды/события',
    fields: [
      {
        key: 'type', label: 'Тип', kind: 'multi', required: true,
        options: [
          { key: 'rash', label: 'высыпание' },
          { key: 'redness', label: 'краснота' },
          { key: 'itch', label: 'зуд' },
          { key: 'gi', label: 'ЖКТ' },
          { key: 'ears', label: 'трёт уши' },
          { key: 'other', label: 'другое' },
        ],
      },
      {
        key: 'strength', label: 'Сила', kind: 'single', required: false,
        options: [
          { key: 'weak', label: 'слабая' },
          { key: 'med', label: 'средняя' },
          { key: 'strong', label: 'сильная' },
        ],
      },
      { key: 'note', label: 'Заметка', kind: 'text', required: false },
    ],
  },

  {
    key: 'mood',
    label: 'Настроение',
    icon: '🙂',
    description: 'как он в целом сейчас',
    fields: [
      {
        key: 'state', label: 'Как', kind: 'single', required: true,
        options: [
          { key: 'calm', label: 'спокоен' },
          { key: 'bright', label: 'бодр' },
          { key: 'tired', label: 'уставший' },
          { key: 'crying', label: 'плачет' },
          { key: 'irritable', label: 'раздражён' },
        ],
      },
      { key: 'note', label: 'Заметка', kind: 'text', required: false },
    ],
  },

  {
    key: 'sleep',
    label: 'Сон',
    icon: '💤',
    description: 'начало · конец · качество',
    fields: [
      {
        key: 'phase', label: 'Фаза', kind: 'single', required: true,
        options: [
          { key: 'fell_asleep', label: 'уснул' },
          { key: 'woke_up', label: 'проснулся' },
          { key: 'nap', label: 'дневной сон' },
        ],
      },
      {
        key: 'quality', label: 'Качество', kind: 'single', required: false,
        options: [
          { key: 'bad', label: 'плохо' },
          { key: 'ok', label: 'норм' },
          { key: 'good', label: 'хорошо' },
        ],
      },
      { key: 'note', label: 'Заметка', kind: 'text', required: false },
    ],
  },

  {
    key: 'meds',
    label: 'Лекарства',
    icon: '💊',
    description: 'что · дозировка',
    fields: [
      { key: 'name', label: 'Что', kind: 'text', required: true, placeholder: 'название' },
      { key: 'dose', label: 'Доза', kind: 'text', required: false, placeholder: 'например, 5 капель' },
      { key: 'note', label: 'Заметка', kind: 'text', required: false },
    ],
  },

  {
    key: 'symptom',
    label: 'Симптом',
    icon: '🩺',
    description: 'плач · спазм · беспокойство',
    fields: [
      {
        key: 'kind', label: 'Что', kind: 'multi', required: true,
        options: [
          { key: 'cry', label: 'плач' },
          { key: 'spasm', label: 'спазм' },
          { key: 'legs_up', label: 'ноги к животу' },
          { key: 'trembling', label: 'дрожь' },
          { key: 'sweat', label: 'пот' },
          { key: 'ears', label: 'трёт уши' },
          { key: 'other', label: 'другое' },
        ],
      },
      {
        key: 'intensity', label: 'Интенсивность', kind: 'single', required: false,
        options: [
          { key: 'weak', label: 'слабая' },
          { key: 'med', label: 'средняя' },
          { key: 'strong', label: 'сильная' },
        ],
      },
      { key: 'note', label: 'Заметка', kind: 'text', required: false },
    ],
  },
];

window.TYPE_BY_KEY = Object.fromEntries(window.TYPES.map(t => [t.key, t]));
