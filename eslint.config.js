/**
 * Flat ESLint config, layered on `eslint-config-expo`.
 *
 * The four custom rules below are not style preferences. Each one closes a hole
 * that this app's design depends on and that nothing else can catch:
 *
 *  1. RAW COLOURS — the theme is the only place that knows about light/dark and
 *     about the rule that an out-of-range reading is NEVER coloured red. A hex
 *     literal in a screen quietly opts out of both.
 *
 *  2. Alert.alert / global confirm — the app ships `useConfirm()`, which renders
 *     a large-target, translated, theme-aware dialog. A system Alert is English-
 *     only on some OEM skins, ignores the large-text setting entirely, and its
 *     buttons are far below the 56dp touch target this app is calibrated to.
 *
 *  3. `fontSize` imported directly from `@/theme` — that export is the BASE
 *     scale. `useFontSizes()` returns it multiplied by the large-text factor.
 *     A screen reading the raw table renders at 17sp for a user who explicitly
 *     asked for 21sp, and the bypass is completely invisible in review.
 *
 *  4. `expo-notifications` — the local `modules/med-alarm` module is the only
 *     SCHEDULER. expo-notifications' Android scheduling goes through
 *     AlarmManager without the exact-alarm and boot-restore handling this app
 *     needs, so a second scheduler means doses fire twice or not at all, and
 *     both failures look like "the reminder is unreliable".
 *
 *     There is NO exemption. A shared profile notifies a non-owner phone by
 *     scheduling the same dose QUIETLY through med-alarm (deviceHorizon.ts's
 *     `toQuietRules` maps it onto `dose_low_v1`), which needs no push service, no
 *     token, and works with no network at dose time. Nothing in this app may
 *     import expo-notifications.
 *
 * Each rule is scoped to the directories where it is actually load-bearing, so
 * the theme itself, the config plugins and the scripts are not fighting it.
 */

const expoConfig = require('eslint-config-expo/flat');

/**
 * esquery attribute selectors take a regex written INLINE, between slashes, and
 * parse it out of the selector text themselves. They are therefore written as
 * literal strings below rather than derived from a RegExp object — `.source`
 * round-tripped through a string ends up double-escaped and esquery fails to
 * parse it at all ("Unterminated group"), which takes down the whole lint run.
 *
 *   HEX  '#abc' / '#aabb' / '#aabbcc' / '#aabbccdd', anchored so that a string
 *        which merely CONTAINS a '#' (a URL fragment, a format template) is not
 *        mistaken for a colour.
 *   RGB  'rgb(' / 'rgba(' anywhere in the literal.
 */
const HEX_COLOUR_SELECTOR =
  "Literal[value=/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]";
const RGB_COLOUR_SELECTOR = "Literal[value=/rgba?[ ]*[(]/]";
const HEX_IN_TEMPLATE_SELECTOR = "TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}/]";

const RAW_COLOUR_MESSAGE =
  'Raw colour literal. Use a theme token from useTheme().colors — the theme is the ' +
  'only place that knows about dark mode, and about the rule that a reading is never ' +
  'coloured red. If this genuinely is not a colour, rename it so it does not look like one.';

module.exports = [
  ...expoConfig,

  {
    ignores: [
      'node_modules/**',
      'android/**',
      'ios/**',
      'build-output/**',
      '.expo/**',
      'dist/**',
      // Generated output from scripts/gen-icons.js.
      'assets/**',
    ],
  },

  // ── React Compiler rules: advisory, not blocking ───────────────────────────
  //
  // eslint-config-expo 57 turns on the React Compiler's lint rules AS ERRORS.
  // They fire ~26 times across this codebase, almost all on the classic
  // `useRef(new Animated.Value(0))` pattern that every RN animation in
  // src/components/ui uses, plus `setState` inside a load effect.
  //
  // The React Compiler is NOT enabled in this project (there is no
  // babel.config.js turning it on), so those patterns are correct today. They
  // stay visible as warnings — they are a real to-do if the compiler is ever
  // switched on — but they must not be errors, because 26 pre-existing errors
  // is the same as no lint at all: nobody runs it, and the four rules below,
  // which genuinely matter, never get seen.
  //
  // `import/no-unresolved` is deliberately LEFT AS AN ERROR. It currently
  // reports two genuinely missing modules (@/features/backup's index and
  // @/features/sync). That is a broken import, not a style opinion.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },

  // ── Whole project ──────────────────────────────────────────────────────────
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'expo-notifications',
              message:
                'expo-notifications is not the scheduler for this app. Dose reminders go ' +
                'through modules/med-alarm (exact alarms + boot restore + an append-only ' +
                'native journal). A second scheduler means a dose fires twice or not at all.',
            },
          ],
          patterns: [
            {
              group: ['expo-notifications/*'],
              message:
                'expo-notifications is not the scheduler for this app. Use modules/med-alarm.',
            },
          ],
        },
      ],
    },
  },

  // ── Screens and components ─────────────────────────────────────────────────
  {
    files: ['src/app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // A string literal that IS a colour.
          selector: HEX_COLOUR_SELECTOR,
          message: RAW_COLOUR_MESSAGE,
        },
        {
          selector: RGB_COLOUR_SELECTOR,
          message: RAW_COLOUR_MESSAGE,
        },
        {
          // Template literals carry no `value`, so match their raw text instead.
          selector: HEX_IN_TEMPLATE_SELECTOR,
          message: RAW_COLOUR_MESSAGE,
        },
        {
          selector: `CallExpression[callee.object.name='Alert'][callee.property.name='alert']`,
          message:
            'Alert.alert() is banned. Use the toast (useToast) for information and ' +
            'useConfirm() for a decision — both are translated, theme-aware, and honour ' +
            'the large-text setting, which a system Alert does not.',
        },
        {
          selector: `CallExpression[callee.object.name='Alert'][callee.property.name='prompt']`,
          message: 'Alert.prompt() is banned. Use an in-app screen or useConfirm().',
        },
      ],

      // Catches a bare `confirm(...)` that resolves to the DOM/global function.
      // `const { confirm } = useConfirm()` creates a local binding and is not
      // flagged, which is exactly the distinction we want.
      'no-restricted-globals': [
        'error',
        {
          name: 'confirm',
          message:
            'The global confirm() is banned (and does not exist on React Native). ' +
            'Use useConfirm() from @/components/ui.',
        },
        {
          name: 'alert',
          message: 'The global alert() is banned. Use useToast() from @/components/ui.',
        },
      ],
    },
  },

  // ── Screens only: large-text mode must not be bypassable ───────────────────
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/theme',
              importNames: ['fontSize'],
              message:
                '`fontSize` from @/theme is the BASE scale and ignores large-text mode. ' +
                'Screens must call useFontSizes() from @/theme/ThemeProvider, which returns ' +
                'the same keys already multiplied by the user\'s chosen scale.',
            },
            {
              name: 'expo-notifications',
              message:
                'expo-notifications is not the scheduler for this app. Use modules/med-alarm.',
            },
          ],
          patterns: [
            {
              group: ['**/theme/index', '**/theme/index.ts'],
              importNames: ['fontSize'],
              message:
                '`fontSize` is the BASE scale. Screens must use useFontSizes() so large-text ' +
                'mode cannot be bypassed.',
            },
            {
              group: ['expo-notifications/*'],
              message: 'expo-notifications is not the scheduler for this app.',
            },
          ],
        },
      ],
    },
  },

  // ── Node-side tooling ──────────────────────────────────────────────────────
  // These run in Node, not in the app: CommonJS, console output, and process
  // access are the point of them.
  {
    files: ['scripts/**/*.{js,ts}', 'plugins/**/*.js', 'eslint.config.js', 'app.config.ts'],
    languageOptions: {
      // Declared by hand rather than pulled from the `globals` package, which is
      // not a dependency of this project. Anything a build script legitimately
      // reaches for in Node goes here; leaving one out shows up as a wall of
      // `no-undef` in a file that runs perfectly well.
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        exports: 'writable',
        fetch: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        module: 'writable',
        process: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        structuredClone: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'import/no-commonjs': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
