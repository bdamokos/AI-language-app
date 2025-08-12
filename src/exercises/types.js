// Standardized exercise interfaces (runtime shape docs via JSDoc)

/**
 * Common input config for any exercise generator/renderer
 * @typedef {Object} ExerciseInput
 * @property {string} topic - grammar concept or theme
 * @property {('A1'|'A2'|'B1'|'B2'|'C1'|'C2'|string)=} difficulty
 * @property {('es'|'en'|string)=} language
 * @property {string=} notes - any caveats/notes
 * @property {(args: { prompt: string, schema?: any, schemaName?: string, maxTokens?: number }) => Promise<any>=} llmHook - function delegating to server/LLM
 */

/**
 * Standard output shape for an exercise instance
 * @typedef {Object} ExerciseOutput
 * @property {string} type - e.g. 'fib' | 'mcq' | 'cloze' | 'clozeMix'
 * @property {any} data - raw data used by the renderer (lesson item)
 * @property {any=} possibleSolutions - optional pre-provided solutions
 * @property {string[]=} hints - hints list
 * @property {Object=} userInputs - map of user responses (owned by orchestrator)
 * @property {(normalize: (a:string,b:string)=>boolean) => { correct: number, total: number }} getScore - score function
 * @property {() => boolean=} isComplete - optional completion flag
 */

// Note: Types are for reference; shapes are enforced at usage sites.


