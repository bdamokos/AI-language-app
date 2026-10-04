import { apiFetch } from './utils/api.js';
import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, Send, Check, X, RefreshCw, HelpCircle, Lightbulb, Info, ChevronRight, Globe, GraduationCap } from 'lucide-react';
import Joyride from 'react-joyride';
import { schemaVersions } from '../shared/schemaVersions.js';
import Orchestrator, { scoreLesson, generateLesson } from './exercises/Orchestrator.jsx';
import { scoreFIB, generateFIB } from './exercises/FIBExercise.jsx';
import { scoreMCQ, generateMCQ } from './exercises/MCQExercise.jsx';
import { scoreCloze, generateCloze } from './exercises/ClozeExercise.jsx';
import { scoreClozeMixed, generateClozeMixed } from './exercises/ClozeMixedExercise.jsx';
import { generateExplanation, generateExplanationStream } from './exercises/ExplanationComponent.jsx';
import { generateGuidedDialogues } from './exercises/GuidedDialogueExercise.jsx';
import { generateWritingPrompts } from './exercises/WritingPromptExercise.jsx';
import { generateReading, scoreReading } from './exercises/ReadingExercise.jsx';
import { generateRewriting, scoreRewriting } from './exercises/RewritingExercise.jsx';
import { normalizeText as normalizeTextUtil } from './exercises/utils.js';
import { generateErrorBundles, scoreErrorBundle } from './exercises/ErrorBundleExercise.jsx';
import LanguageLevelSelector from './LanguageLevelSelector.jsx';
import PDFExport from './components/PDFExport.jsx';
import useBaseText from './hooks/useBaseText.js';
import { createChapterPool } from './utils/chapterPool.js';
import useOnboardingTour from './hooks/useOnboardingTour.js';

export function collectWrongExercises(lesson, values, strictAccents = true) {
  const eq = (a, b) => normalizeTextUtil(a, strictAccents) === normalizeTextUtil(b, strictAccents);
  const sections = [
    ['fib', 'fill_in_blanks', (item, value) => scoreFIB(item, value || {}, eq)],
    ['mcq', 'multiple_choice', scoreMCQ],
    ['cloze', 'cloze_passages', (item, value) => scoreCloze(item, value || {}, eq)],
    ['clozeMix', 'cloze_with_mixed_options', (item, value) => scoreClozeMixed(item, value || {}, eq)],
    ['reading', 'reading_comprehension', (item, value) => scoreReading(item, value || {})],
    ['rewrite', 'rewriting', (item, value) => scoreRewriting(item, value || '', eq)],
    ['error', 'error_bundles', (item, value, index) => scoreErrorBundle(item, value, eq, strictAccents, index)],
  ];
  return sections.flatMap(([type, field, score]) => (lesson?.[field] || []).flatMap((item, index) => {
    const userAnswer = values?.[`lesson:${type}:${index}`];
    const result = score(item, userAnswer, index);
    return result.correct < result.total ? [{ type, index, item, userAnswer: userAnswer ?? null }] : [];
  }));
}

const AIPracticeApp = ({ onNewLesson }) => {
  // Language and level context
  const [languageContext, setLanguageContext] = useState(null);
  
  const [topic, setTopic] = useState('');
  const [exerciseCount, setExerciseCount] = useState(10);
  const [exercises, setExercises] = useState([]); // simple FIB list (legacy)
  const [userAnswers, setUserAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [sectionSubmitted, setSectionSubmitted] = useState({}); // e.g. { mcq: true, fib: true, cloze: {0:true} }
  const [loading, setLoading] = useState(false);
  const [explanations, setExplanations] = useState({});
  const [loadingExplanation, setLoadingExplanation] = useState({});
  const [recommendation, setRecommendation] = useState(null);
  const [loadingRecommendation, setLoadingRecommendation] = useState(false);
  const [visibleHints, setVisibleHints] = useState({});
  const [showContext, setShowContext] = useState({});
  const [strictAccents, setStrictAccents] = useState(true);
  const [showAccentBar, setShowAccentBar] = useState(false);
  const [lastFocusedInput, setLastFocusedInput] = useState(null);
  const [lesson, setLesson] = useState(null);
  const [loadingLesson, setLoadingLesson] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [loadingExplOnly, setLoadingExplOnly] = useState(false);
  const [loadingFibOnly, setLoadingFibOnly] = useState(false);
  const [loadingMcqOnly, setLoadingMcqOnly] = useState(false);
  const [loadingClozeOnly, setLoadingClozeOnly] = useState(false);
  const [loadingClozeMixOnly, setLoadingClozeMixOnly] = useState(false);
  const [loadingDialogueOnly, setLoadingDialogueOnly] = useState(false);
  const [loadingWritingOnly, setLoadingWritingOnly] = useState(false);
  const [mcqCount, setMcqCount] = useState(5);
  const [clozeCount, setClozeCount] = useState(1);
  const [clozeMixCount, setClozeMixCount] = useState(1);
  const [dialogueCount, setDialogueCount] = useState(1);
  const [writingCount, setWritingCount] = useState(1);
  const [readingCount, setReadingCount] = useState(1);
  const [rewritingCount, setRewritingCount] = useState(5);
  const [errorBundleCount, setErrorBundleCount] = useState(4);
  const { fetchBaseText } = useBaseText();
  const chapterPool = useRef(null);
  if (!chapterPool.current) chapterPool.current = createChapterPool(fetchBaseText);
  useEffect(() => () => chapterPool.current.reset(), []);
  const [generationStage, setGenerationStage] = useState({});

  const resetLessonWork = () => {
    chapterPool.current.reset();
    setGenerationStage({});
    setErrorMsg('');
    setLoadingLesson(false); setLoadingExplOnly(false); setLoadingFibOnly(false);
    setLoadingMcqOnly(false); setLoadingClozeOnly(false); setLoadingClozeMixOnly(false);
    setLoadingDialogueOnly(false); setLoadingWritingOnly(false); setLoadingReadingOnly(false);
    setLoadingErrorBundlesOnly(false); setLoadingRewritingOnly(false);
    setLoadingExplanation({}); setLoadingRecommendation(false);
  };

  const generateFromChapters = async (type, count, batchSize, generate, excludeIds = []) => {
    const signal = chapterPool.current.signal;
    try {
      return await chapterPool.current.run({
        context: { topic, language: languageContext?.language || 'es', level: languageContext?.level || 'B1', challengeMode: !!languageContext?.challengeMode },
        count, batchSize, excludeIds,
        generate: (amount, context) => generate(topic, amount, context),
        onStage: stage => { if (!signal.aborted) setGenerationStage(previous => ({ ...previous, [type]: stage })); }
      });
    } catch (error) {
      if (!signal.aborted && error.partialItems?.length) {
        setErrorMsg(`Generated ${error.partialItems.length} of ${count} exercises. ${error.message}`);
        return { items: error.partialItems };
      }
      throw error;
    }
  };

  // Onboarding / tour state
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const onboarding = useOnboardingTour({
    version: schemaVersions?.onboarding ?? 1,
    phase: languageContext ? 'post' : 'pre',
    ready: !languageContext || Boolean(lesson?.explanation?.content_markdown && !loadingLesson && !loadingExplOnly),
  });

  const preTourSteps = [
    {
      target: '#language-selector-root',
      content: 'Welcome! Let\'s set up your lesson. We\'ll choose a language, level, and topic, then generate an explanation and practice exercises.',
      placement: 'center'
    },
    {
      target: '#popular-languages',
      content: 'Pick a popular language here, or enter any language below if yours isn\'t listed.',
      placement: 'bottom'
    },
    {
      target: '#custom-language',
      content: 'Want a different language? Type it here. The app works with any language the AI can handle.',
      placement: 'top'
    },
    {
      target: '#level-selection',
      content: 'Select your CEFR level. This controls difficulty. You can enable Challenge Mode next to push yourself a bit.',
      placement: 'left'
    },
    {
      target: '#challenge-mode',
      content: 'Toggle Challenge Mode for slightly more difficult content than your chosen level.',
      placement: 'top'
    },
    {
      target: '#topic-input',
      content: 'Enter a practice topic. Tip: try "past tense" or something specific (e.g., "preterite tense", "vocabulary for checking in to a hotel", etc.).',
      placement: 'top'
    },
    {
      target: '#start-lesson-button',
      content: 'All set! Click here to generate your lesson and explanation. You can reopen the tutorial from Help after your lesson starts. \n \n Please be aware that the AI may create gibberish or plausible sounding but incorrect content. Please check the explanation and exercises carefully.',
      placement: 'top'
    }
  ];

  const postTourSteps = [
    {
      target: '#exercise-generation-controls',
      content: 'Use these buttons to generate exercises. New sets appear below the explanation and use your ChatGPT plan allowance.',
      placement: 'bottom'
    },
    {
      target: '#check-answers-button',
      content: 'When you are done, click here to check your answers and get feedback.',
      placement: 'top'
    },
    {
      target: '#export-pdf-button',
      content: 'Export the entire lesson and solutions to a nicely formatted PDF.',
      placement: 'left'
    },
    {
      target: 'body',
      content: 'Want to change the exercise topic? Just reload your browser to start fresh.',
      placement: 'center'
    }
  ];

  const normalizeText = (text) => normalizeTextUtil(text, strictAccents);

  // Helper function to get language display name
  const getLanguageDisplayName = (languageName) => {
    // Ensure proper capitalization
    return String(languageName || '').charAt(0).toUpperCase() + String(languageName || '').slice(1);
  };

  // Handle language and level selection
  const handleLanguageLevelStart = async (context) => {
    resetLessonWork();
    const signal = chapterPool.current.signal;
    setLanguageContext(context);
    setTopic(context.topic || '');
    
    // Set accent settings from context
    if (context.strictAccents !== undefined) {
      setStrictAccents(context.strictAccents);
    }
    if (context.showAccentBar !== undefined) {
      setShowAccentBar(context.showAccentBar);
    }
    
    // Automatically start lesson generation
    if (context.topic) {
      setLoadingLesson(true);
      setErrorMsg('');
      // Seed skeleton with placeholder explanation so UI shows streaming immediately
      setLesson({
        version: '1.1',
        language: context.language,
        topic: context.topic,
        pedagogy: { approach: 'orchestrated-base-text', strategy_notes: '' },
        explanation: { title: `Generating “${context.topic}”...`, content_markdown: '' },
        fill_in_blanks: [], multiple_choice: [], cloze_passages: [], cloze_with_mixed_options: [],
        guided_dialogues: [], writing_prompts: [], reading_comprehension: [], error_bundles: [], rewriting: [],
        error_bundles_shared_context: ''
      });
      setOrchestratorValues({});
      try {
        const final = await generateExplanationStream(context.topic, { ...context, signal }, (evt) => {
          if (signal.aborted) return;
          if (evt?.type === 'delta' || evt?.type === 'prefill') {
            setLesson(prev => prev ? ({ ...prev, explanation: evt.explanation || { title: evt.title || prev.explanation?.title || `Generating “${context.topic}”...`, content_markdown: (prev.explanation?.content_markdown || '') + (evt.text || '') } }) : prev);
          }
        });
        if (!signal.aborted) setLesson(prev => prev ? ({ ...prev, explanation: final }) : prev);
      } catch (error) {
        if (signal.aborted) return;
        console.error('Error generating explanation:', error);
        setErrorMsg(error.message || 'Error generating explanation. Please try again.');
        setLesson(prev => prev ? ({ ...prev, explanation: { ...prev.explanation, title: 'Explanation unavailable' } }) : prev);
      } finally {
        if (!signal.aborted) setLoadingLesson(false);
      }
    }
  };

  // Reset to language selection
  const resetToLanguageSelection = () => {
    resetLessonWork();
    if (onNewLesson) { onNewLesson(); return; }
    setLanguageContext(null);
    setTopic('');
    setExercises([]);
    setUserAnswers({});
    setSubmitted(false);
    setExplanations({});
    setRecommendation(null);
    setVisibleHints({});
    setShowContext({});
    setLesson(null);
    setOrchestratorValues({});
  };

  const insertAccent = (accent) => {
    if (!lastFocusedInput) return;
    const input = document.querySelector(`input[data-key="${lastFocusedInput}"]`);
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    // Orchestrator-managed keys: lesson:type:idx:blankIdx
    if (lastFocusedInput.startsWith('lesson:')) {
      const parts = lastFocusedInput.split(':');
      if (parts.length >= 4) {
        const baseKey = parts.slice(0, 3).join(':');
        const blankIdx = parts[3];
        const currentObj = orchestratorValues[baseKey] || {};
        const currentValue = String(currentObj[blankIdx] || '');
        const newValue = currentValue.substring(0, start) + accent + currentValue.substring(end);
        setOrchestratorValues(prev => ({
          ...prev,
          [baseKey]: { ...(prev[baseKey] || {}), [blankIdx]: newValue }
        }));
        setTimeout(() => {
          input.focus();
          input.setSelectionRange(start + 1, start + 1);
        }, 0);
        return;
      }
      // Support single-field orchestrator inputs like ErrorBundle correction: lesson:type:idx
      if (parts.length === 3) {
        const baseKey = parts.join(':');
        const currentValue = String(orchestratorValues[baseKey] || '');
        const newValue = currentValue.substring(0, start) + accent + currentValue.substring(end);
        setOrchestratorValues(prev => ({
          ...prev,
          [baseKey]: newValue
        }));
        setTimeout(() => {
          input.focus();
          input.setSelectionRange(start + 1, start + 1);
        }, 0);
        return;
      }
    }
    // Legacy FIB keys stored in userAnswers
    const currentValue = String(userAnswers[lastFocusedInput] || '');
    const newValue = currentValue.substring(0, start) + accent + currentValue.substring(end);
    setUserAnswers({
      ...userAnswers,
      [lastFocusedInput]: newValue
    });
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(start + 1, start + 1);
    }, 0);
  };

  const parseMarkdown = (text) => <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(text || '')}</ReactMarkdown>;

  // keyPrefix allows scoping inputs for different sections/passages
  const parseExerciseSentence = (sentence, exerciseIndex, keyPrefix = 'fib', answerLookup = null) => {
    const parts = sentence.split(/_____/);
    const segments = [];
    parts.forEach((part, index) => {
      segments.push(<span key={`text-${index}`}>{part}</span>);
      if (index < parts.length - 1) {
        const answerKey = `${keyPrefix}:${exerciseIndex}-${index}`;
        const userAnswer = userAnswers[answerKey] || '';
        let currentAnswer = '';
        if (Array.isArray(answerLookup)) {
          currentAnswer = answerLookup[index] || '';
        } else {
          const exercise = exercises[exerciseIndex];
          const correctAnswers = exercise?.answer ? exercise.answer.split(',').map(a => a.trim()) : [];
          currentAnswer = correctAnswers[index] || '';
        }
        const isCorrect = submitted && currentAnswer && normalizeText(userAnswer) === normalizeText(currentAnswer);
        const isWrong = submitted && userAnswer && currentAnswer && !isCorrect;
        segments.push(
          <input
            key={`input-${index}`}
            data-key={answerKey}
            type="text"
            value={userAnswer}
            onChange={(e) => handleAnswerChange(answerKey, e.target.value)}
            onFocus={() => setLastFocusedInput(answerKey)}
            className={`mx-1 px-2 py-0.5 border rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent inline-block w-32 ${
              isCorrect ? 'border-green-500 bg-green-50' : 
              isWrong ? 'border-red-500 bg-red-50' : 
              'border-gray-300'
            }`}
            placeholder="..."
          />
        );
        if (submitted && currentAnswer) {
          segments.push(
            <span key={`feedback-${index}`} className="ml-1">
              {isCorrect ? (
                <Check className="text-green-600 inline" size={16} />
              ) : (
                <span className="text-sm text-red-600">({currentAnswer})</span>
              )}
            </span>
          );
        }
      }
    });
    return segments;
  };

  // Create generation controls component
  const renderGenerationControls = () => (
    <div id="exercise-generation-controls" className="mt-3 p-3 bg-gray-50 rounded">
      <div className="font-semibold text-gray-800 mb-2">Add content</div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 items-center">
        <button
          onClick={generateExplanationOnly}
          disabled={loadingLesson || loadingExplOnly || !topic.trim()}
          className="w-full bg-gray-800 text-white py-2 px-4 rounded hover:bg-gray-900 text-sm"
        >{loadingLesson || loadingExplOnly ? 'Generating explanation…' : 'Generate Explanation'}</button>

        <div className="flex gap-2">
          <button
            onClick={generateFIBOnly}
            disabled={loadingFibOnly || !topic.trim()}
            className="flex-1 bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 text-sm"
          >{loadingFibOnly ? (generationStage.fib || 'Generating…') : `Add FIB (${exerciseCount})`}</button>
          <input type="number" min={1} max={20} value={exerciseCount} onChange={e => setExerciseCount(e.target.value)} className="w-16 px-2 py-1 border rounded text-sm" />
        </div>

        <div className="flex gap-2">
          <button
            onClick={generateMCQOnly}
            disabled={loadingMcqOnly || !topic.trim()}
            className="flex-1 bg-teal-600 text-white py-2 px-4 rounded hover:bg-teal-700 text-sm"
          >{loadingMcqOnly ? 'Generating...' : `Add MCQ (${mcqCount})`}</button>
          <input type="number" min={1} max={20} value={mcqCount} onChange={e => setMcqCount(e.target.value)} className="w-16 px-2 py-1 border rounded text-sm" />
        </div>

        <div className="flex gap-2">
          <button
            onClick={generateClozeOnly}
            disabled={loadingClozeOnly || !topic.trim()}
            className="flex-1 bg-amber-600 text-white py-2 px-4 rounded hover:bg-amber-700 text-sm"
          >{loadingClozeOnly ? (generationStage.cloze || 'Generating…') : `Add Cloze (${clozeCount})`}</button>
          <input type="number" min={1} max={10} value={clozeCount} onChange={e => setClozeCount(e.target.value)} className="w-16 px-2 py-1 border rounded text-sm" />
        </div>

        <div className="flex gap-2">
          <button
            onClick={generateClozeMixOnly}
            disabled={loadingClozeMixOnly || !topic.trim()}
            className="flex-1 bg-fuchsia-600 text-white py-2 px-4 rounded hover:bg-fuchsia-700 text-sm"
          >{loadingClozeMixOnly ? (generationStage.clozeMixed || 'Generating…') : `Add Cloze-Mixed (${clozeMixCount})`}</button>
          <input type="number" min={1} max={10} value={clozeMixCount} onChange={e => setClozeMixCount(e.target.value)} className="w-16 px-2 py-1 border rounded text-sm" />
        </div>

        <div className="flex gap-2">
          <button
            onClick={generateDialogueOnly}
            disabled={loadingDialogueOnly || !topic.trim()}
            className="flex-1 bg-indigo-600 text-white py-2 px-4 rounded hover:bg-indigo-700 text-sm"
          >{loadingDialogueOnly ? 'Generating...' : `Add Guided Dialogues (${dialogueCount})`}</button>
          <input type="number" min={1} max={10} value={dialogueCount} onChange={e => setDialogueCount(e.target.value)} className="w-16 px-2 py-1 border rounded text-sm" />
        </div>

        <div className="flex gap-2">
          <button
            onClick={generateWritingOnly}
            disabled={loadingWritingOnly || !topic.trim()}
            className="flex-1 bg-rose-600 text-white py-2 px-4 rounded hover:bg-rose-700 text-sm"
          >{loadingWritingOnly ? 'Generating...' : `Add Writing Prompts (${writingCount})`}</button>
          <input type="number" min={1} max={10} value={writingCount} onChange={e => setWritingCount(e.target.value)} className="w-16 px-2 py-1 border rounded text-sm" />
        </div>

        <div className="flex gap-2">
          <button
            onClick={generateReadingOnly}
            disabled={loadingReadingOnly || !topic.trim()}
            className="flex-1 bg-emerald-600 text-white py-2 px-4 rounded hover:bg-emerald-700 text-sm"
          >{loadingReadingOnly ? (generationStage.reading || 'Generating…') : `Generate Reading Passage (${readingCount})`}</button>
          <input type="number" min={1} max={5} value={readingCount} onChange={e => setReadingCount(e.target.value)} className="w-16 px-2 py-1 border rounded text-sm" />
        </div>

        <div className="flex gap-2">
          <button
            onClick={generateRewritingOnly}
            disabled={loadingRewritingOnly || !topic.trim()}
            className="flex-1 bg-cyan-600 text-white py-2 px-4 rounded hover:bg-cyan-700 text-sm"
          >{loadingRewritingOnly ? (generationStage.rewriting || 'Generating…') : `Add Rewriting (${rewritingCount})`}</button>
          <input type="number" min={1} max={20} value={rewritingCount} onChange={e => setRewritingCount(e.target.value)} className="w-16 px-2 py-1 border rounded text-sm" />
        </div>

        <div className="flex gap-2">
          <button
            onClick={generateErrorBundlesOnly}
            disabled={loadingErrorBundlesOnly || !topic.trim()}
            className="flex-1 bg-slate-700 text-white py-2 px-4 rounded hover:bg-slate-800 text-sm"
          >{loadingErrorBundlesOnly ? (generationStage.errorBundle || 'Generating…') : `Add Error Bundles (${errorBundleCount})`}</button>
          <input type="number" min={2} max={12} value={errorBundleCount} onChange={e => setErrorBundleCount(e.target.value)} className="w-16 px-2 py-1 border rounded text-sm" />
        </div>
      </div>
    </div>
  );

  const renderLessonPanel = () => (
    lesson && (
      <div className="border rounded-lg p-4 space-y-3">
        <div className="flex justify-between items-start">
          <div>
            <h2 className="text-xl font-semibold text-gray-800">Lesson: {lesson.topic}</h2>
            {lesson.pedagogy?.strategy_notes && (
              <p className="text-sm text-gray-600">Approach: scaffolded+spiral — {lesson.pedagogy.strategy_notes}</p>
            )}
          </div>
          <PDFExport lesson={lesson} orchestratorValues={orchestratorValues} strictAccents={strictAccents} />
        </div>
        <Orchestrator
          lesson={lesson}
          values={orchestratorValues}
          onChange={(key, val) => setOrchestratorValues(prev => ({ ...prev, [key]: val }))}
          checked={submitted}
          strictAccents={strictAccents}
          idBase="lesson"
          onFocusKey={(k) => setLastFocusedInput(k)}
          renderGenerationControls={renderGenerationControls}
        />
      </div>
    )
  );

  const generateLessonContent = async (t) => {
    const topicToUse = (typeof t === 'string' && t.trim()) ? t.trim() : String(topic || '').trim();
    if (!topicToUse) return;
    resetLessonWork();
    const signal = chapterPool.current.signal;
    setRecommendation(null);
    setLoadingLesson(true);
    setErrorMsg('');
    // Ensure newly generated lesson starts unchecked
    setSubmitted(false);
    setLesson(null);
    try {
      // Stream only the explanation initially; other content is generated on-demand
      setTopic(topicToUse);
      setLesson({
        version: '1.1',
        language: languageContext?.language || 'es',
        topic: topicToUse,
        pedagogy: { approach: 'orchestrated-base-text', strategy_notes: '' },
        explanation: { title: `Generating “${topicToUse}”...`, content_markdown: '' },
        fill_in_blanks: [], multiple_choice: [], cloze_passages: [], cloze_with_mixed_options: [],
        guided_dialogues: [], writing_prompts: [], reading_comprehension: [], error_bundles: [], rewriting: [],
        error_bundles_shared_context: ''
      });
      setOrchestratorValues({});
      const final = await generateExplanationStream(topicToUse, { ...languageContext, signal }, (evt) => {
        if (signal.aborted) return;
        if (evt?.type === 'delta' || evt?.type === 'prefill') {
          setLesson(prev => prev ? ({ ...prev, explanation: evt.explanation || { title: evt.title || prev.explanation?.title || `Generating “${topicToUse}”...`, content_markdown: (prev.explanation?.content_markdown || '') + (evt.text || '') } }) : prev);
        }
      });
      if (!signal.aborted) setLesson(prev => prev ? ({ ...prev, explanation: final }) : prev);
    } catch (error) {
      if (signal.aborted) return;
      console.error('Error generating lesson (explanation):', error);
      setErrorMsg(error.message || 'Error generating lesson. Please try again.');
      setLesson(prev => prev ? ({ ...prev, explanation: { ...prev.explanation, title: 'Explanation unavailable' } }) : prev);
    } finally {
      if (!signal.aborted) setLoadingLesson(false);
    }
  };

  const ensureLessonSkeleton = () => ({
    version: '1.0',
    language: languageContext?.language || 'es',
    topic: topic || (lesson?.topic || ''),
    pedagogy: { approach: 'scaffolded+spiral', strategy_notes: '' },
    explanation: lesson?.explanation || null,
    fill_in_blanks: lesson?.fill_in_blanks || [],
    multiple_choice: lesson?.multiple_choice || [],
    cloze_passages: lesson?.cloze_passages || [],
    cloze_with_mixed_options: lesson?.cloze_with_mixed_options || [],
    guided_dialogues: lesson?.guided_dialogues || [],
    writing_prompts: lesson?.writing_prompts || [],
    reading_comprehension: lesson?.reading_comprehension || [],
    error_bundles: lesson?.error_bundles || [],
    rewriting: lesson?.rewriting || [],
    error_bundles_shared_context: lesson?.error_bundles_shared_context || ''
  });

  const mergeLesson = (partial) => {
    // If we are adding any new exercises, reset checked state so they render unsubmitted
    const addsExercises = ['fill_in_blanks', 'multiple_choice', 'cloze_passages', 'cloze_with_mixed_options', 'guided_dialogues', 'writing_prompts', 'reading_comprehension', 'error_bundles', 'rewriting']
      .some(k => Array.isArray(partial?.[k]) && partial[k].length > 0);

    setLesson(prev => {
      const base = prev || ensureLessonSkeleton();
      const next = { ...base };
      for (const [k, v] of Object.entries(partial || {})) {
        if (Array.isArray(v)) {
          const existing = Array.isArray(base[k]) ? base[k] : [];
          next[k] = [...existing, ...v];
        } else {
          next[k] = v;
        }
      }
      // Always keep topic in sync if provided
      if (partial?.topic) next.topic = partial.topic;
      return next;
    });
    if (addsExercises) {
      setSubmitted(false);
    }
  };

  const generateExplanationOnly = async () => {
    if (!topic.trim()) return;
    const signal = chapterPool.current.signal;
    setLoadingExplOnly(true);
    setErrorMsg('');
    try {
      // Start streaming into lesson shell
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, explanation: { title: `Generating “${topic}”...`, content_markdown: '' } });
      const final = await generateExplanationStream(topic, { ...languageContext, signal }, (evt) => {
        if (signal.aborted) return;
        if (evt?.type === 'delta' || evt?.type === 'prefill') {
          setLesson(prev => prev ? ({ ...prev, explanation: evt.explanation || { title: evt.title || prev.explanation?.title || `Generating “${topic}”...`, content_markdown: (prev.explanation?.content_markdown || '') + (evt.text || '') } }) : prev);
        }
      });
      if (!signal.aborted) mergeLesson({ topic, explanation: final });
    } catch (e) {
      if (signal.aborted) return;
      setErrorMsg(e.message || 'Failed to generate explanation');
      setLesson(prev => prev ? ({ ...prev, explanation: { ...prev.explanation, title: 'Explanation unavailable' } }) : prev);
    }
    finally { if (!signal.aborted) setLoadingExplOnly(false); }
  };

  const generateFIBOnly = async () => {
    if (!topic.trim()) return;
    const signal = chapterPool.current.signal;
    setLoadingFibOnly(true); setErrorMsg('');
    try {
      const data = await generateFromChapters('fib', Math.max(1, Math.min(20, Math.floor(Number(exerciseCount)) || 1)), 10, generateFIB);
      if (signal.aborted) return;
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, fill_in_blanks: data.items.map(item => ({ ...item, createdAt: Date.now() })) });
    } catch (error) { if (signal.aborted) return; setErrorMsg(error.message || 'Failed to generate FIB'); }
    finally { if (!signal.aborted) setLoadingFibOnly(false); }
  };

  const generateMCQOnly = async () => {
    if (!topic.trim()) return;
    const signal = chapterPool.current.signal;
    setLoadingMcqOnly(true);
    setErrorMsg('');
    try {
      const data = await generateMCQ(topic, Number(mcqCount), { ...languageContext, signal });
      // Add creation timestamp to each exercise
      const timestampedItems = (data.items || []).map(item => ({ ...item, createdAt: Date.now() }));
      if (signal.aborted) return;
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, multiple_choice: timestampedItems });
    } catch (e) { if (signal.aborted) return; console.error(e); setErrorMsg(e.message || 'Failed to generate MCQ'); }
    finally { if (!signal.aborted) setLoadingMcqOnly(false); }
  };

  const generateClozeOnly = async () => {
    if (!topic.trim()) return;
    const signal = chapterPool.current.signal;
    setLoadingClozeOnly(true); setErrorMsg('');
    try {
      const data = await generateFromChapters('cloze', Math.max(1, Math.min(10, Math.floor(Number(clozeCount)) || 1)), 1,
        (currentTopic, _count, context) => generateCloze(currentTopic, context));
      if (signal.aborted) return;
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, cloze_passages: data.items.map(item => ({ ...item, createdAt: Date.now() })) });
    } catch (error) { if (signal.aborted) return; setErrorMsg(error.message || 'Failed to generate cloze'); }
    finally { if (!signal.aborted) setLoadingClozeOnly(false); }
  };

  const generateClozeMixOnly = async () => {
    if (!topic.trim()) return;
    const signal = chapterPool.current.signal;
    setLoadingClozeMixOnly(true); setErrorMsg('');
    try {
      const data = await generateFromChapters('clozeMixed', Math.max(1, Math.min(10, Math.floor(Number(clozeMixCount)) || 1)), 1,
        (currentTopic, _count, context) => generateClozeMixed(currentTopic, context));
      if (signal.aborted) return;
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, cloze_with_mixed_options: data.items.map(item => ({ ...item, createdAt: Date.now() })) });
    } catch (error) { if (signal.aborted) return; setErrorMsg(error.message || 'Failed to generate cloze-mixed'); }
    finally { if (!signal.aborted) setLoadingClozeMixOnly(false); }
  };

  const generateDialogueOnly = async () => {
    if (!topic.trim()) return;
    const signal = chapterPool.current.signal;
    setLoadingDialogueOnly(true);
    setErrorMsg('');
    try {
      // Find inspiration context from previously used chapters
      let inspirationContext = null;

      if (lesson) {
        // Find exercises that use base texts (reading, cloze, cloze_mixed)
        const baseTextExercises = ['reading_comprehension', 'cloze_passages', 'cloze_with_mixed_options'];
        const usedChapterInfos = [];

        // Collect metadata about used chapters
        for (const exerciseType of baseTextExercises) {
          if (Array.isArray(lesson[exerciseType])) {
            for (const item of lesson[exerciseType]) {
              if (item.base_text_info) {
                usedChapterInfos.push({
                  base_text_id: item.base_text_info.base_text_id,
                  chapter_number: item.base_text_info.chapter_number,
                  chapter_title: item.base_text_info.chapter_title,
                  exercise_type: exerciseType
                });
              }
            }
          }
        }

        // If we have used chapters, try to get their content and pick one for inspiration
        if (usedChapterInfos.length > 0) {
          // Pick a random chapter to inspire from
          const selectedChapter = usedChapterInfos[Math.floor(Math.random() * usedChapterInfos.length)];

          try {
            // Try to fetch the base text content from cache
            console.log('Attempting to fetch base text content for ID:', selectedChapter.base_text_id);
            const baseTextResponse = await apiFetch(`/api/base-text-content/${selectedChapter.base_text_id}`, { signal });
            console.log('Base text response status:', baseTextResponse.status);

            if (baseTextResponse.ok) {
              const baseText = await baseTextResponse.json();
              const content = baseText?.content || baseText; // record wrapper has { key, meta, content }
              console.log('Successfully fetched base text:', content?.title);

              // Find the correct chapter by title since chapter_number might be undefined
              let chapter = null;
              let chapterIndex = -1;

              if (content?.chapters) {
                if (selectedChapter.chapter_number && selectedChapter.chapter_number > 0) {
                  // If we have a valid chapter number, use it
                  chapterIndex = selectedChapter.chapter_number - 1;
                  chapter = content.chapters[chapterIndex];
                } else {
                  // Otherwise, find by title
                  chapterIndex = content.chapters.findIndex(ch => ch.title === selectedChapter.chapter_title);
                  if (chapterIndex !== -1) {
                    chapter = content.chapters[chapterIndex];
                  }
                }
              }

              if (chapter && chapter.passage) {
                const actualChapterNumber = chapterIndex + 1; // 1-based chapter numbering
                inspirationContext = {
                  base_text_id: selectedChapter.base_text_id,
                  chapter_number: actualChapterNumber,
                  chapter_title: chapter.title || selectedChapter.chapter_title,
                  chapter_passage: chapter.passage,
                  exercise_type: selectedChapter.exercise_type
                };
              }
            } else {
              const errorText = await baseTextResponse.text();
              console.warn('Base text fetch failed:', baseTextResponse.status, errorText);
              // Fall back to metadata-only context if content fetch fails
              inspirationContext = selectedChapter;
            }
          } catch (error) {
            if (signal.aborted) return;
            console.warn('Could not fetch base text content for inspiration:', error);
            // Fall back to metadata-only context if content fetch fails
            inspirationContext = selectedChapter;
          }
        }
      }

      if (signal.aborted) return;
      console.log('Final inspirationContext being passed to generateGuidedDialogues:', inspirationContext);
      const data = await generateGuidedDialogues(topic, Number(dialogueCount), { ...languageContext, signal }, inspirationContext);
      // Add creation timestamp to each exercise
      const timestampedItems = (data.items || []).map(item => ({ ...item, createdAt: Date.now() }));
      if (signal.aborted) return;
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, guided_dialogues: timestampedItems });
    } catch (e) { if (signal.aborted) return; console.error(e); setErrorMsg(e.message || 'Failed to generate guided dialogues'); }
    finally { if (!signal.aborted) setLoadingDialogueOnly(false); }
  };

  const generateWritingOnly = async () => {
    if (!topic.trim()) return;
    const signal = chapterPool.current.signal;
    setLoadingWritingOnly(true);
    setErrorMsg('');
    try {
      const data = await generateWritingPrompts(topic, Number(writingCount), { ...languageContext, signal });
      // Add creation timestamp to each exercise
      const timestampedItems = (data.items || []).map(item => ({ ...item, createdAt: Date.now() }));
      if (signal.aborted) return;
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, writing_prompts: timestampedItems });
    } catch (e) { if (signal.aborted) return; console.error(e); setErrorMsg(e.message || 'Failed to generate writing prompts'); }
    finally { if (!signal.aborted) setLoadingWritingOnly(false); }
  };

  const [loadingReadingOnly, setLoadingReadingOnly] = useState(false);
  const generateReadingOnly = async () => {
    if (!topic.trim()) return;
    const signal = chapterPool.current.signal;
    setLoadingReadingOnly(true); setErrorMsg('');
    try {
      const usedReadingBaseTextIds = (lesson?.reading_comprehension || [])
        .map(item => item?.base_text_info?.base_text_id || item?.base_text_id).filter(Boolean);
      const data = await generateFromChapters('reading', Math.max(1, Math.min(5, Math.floor(Number(readingCount)) || 1)), 1, generateReading, usedReadingBaseTextIds);
      if (signal.aborted) return;
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, reading_comprehension: data.items.map(item => ({ ...item, createdAt: Date.now() })) });
    } catch (error) { if (signal.aborted) return; setErrorMsg(error.message || 'Failed to generate reading comprehension'); }
    finally { if (!signal.aborted) setLoadingReadingOnly(false); }
  };

  const handleAnswerChange = (key, value) => {
    setUserAnswers({
      ...userAnswers,
      [key]: value
    });
  };

  const [orchestratorValues, setOrchestratorValues] = useState({});
  const [loadingErrorBundlesOnly, setLoadingErrorBundlesOnly] = useState(false);
  const [loadingRewritingOnly, setLoadingRewritingOnly] = useState(false);
  const generateErrorBundlesOnly = async () => {
    if (!topic.trim()) return;
    const signal = chapterPool.current.signal;
    setLoadingErrorBundlesOnly(true); setErrorMsg('');
    try {
      const count = Math.max(2, Math.min(12, Math.floor(Number(errorBundleCount)) || 2));
      const data = await generateFromChapters('errorBundle', count, count, generateErrorBundles);
      if (signal.aborted) return;
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, error_bundles: data.items.map(item => ({ ...item, createdAt: Date.now() })), error_bundles_shared_context: '' });
    } catch (error) { if (signal.aborted) return; setErrorMsg(error.message || 'Failed to generate error bundles'); }
    finally { if (!signal.aborted) setLoadingErrorBundlesOnly(false); }
  };

  const generateRewritingOnly = async () => {
    if (!topic.trim()) return;
    const signal = chapterPool.current.signal;
    setLoadingRewritingOnly(true); setErrorMsg('');
    try {
      const data = await generateFromChapters('rewriting', Math.max(1, Math.min(20, Math.floor(Number(rewritingCount)) || 1)), 10, generateRewriting);
      if (signal.aborted) return;
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, rewriting: data.items.map(item => ({ ...item, createdAt: Date.now() })) });
    } catch (error) { if (signal.aborted) return; setErrorMsg(error.message || 'Failed to generate rewriting'); }
    finally { if (!signal.aborted) setLoadingRewritingOnly(false); }
  };

  const checkAnswers = () => {
    setSubmitted(true);
    generateRecommendation();
  };

  const checkSection = (key) => {
    setSectionSubmitted(prev => ({ ...prev, [key]: true }));
  };

  const getScore = () => {
    if (lesson) {
      return scoreLesson(lesson, orchestratorValues, strictAccents);
    }
    // fallback: legacy FIB only
    let totalBlanks = 0;
    let correctBlanks = 0;
    exercises.forEach((exercise, exerciseIndex) => {
      const blanksInExercise = (exercise.sentence.match(/_____/g) || []).length;
      const correctAnswers = exercise.answer.split(',').map(a => a.trim());
      for (let blankIndex = 0; blankIndex < blanksInExercise; blankIndex++) {
        totalBlanks++;
        const answerKey = `fib:${exerciseIndex}-${blankIndex}`;
        const userAnswer = userAnswers[answerKey] || '';
        const correctAnswer = correctAnswers[blankIndex] || correctAnswers[0];
        if (normalizeText(userAnswer) === normalizeText(correctAnswer)) {
          correctBlanks++;
        }
      }
    });
    return { correct: correctBlanks, total: totalBlanks };
  };

  const isExerciseCorrect = (exerciseIndex) => {
    const exercise = exercises[exerciseIndex];
    const blanksInExercise = (exercise.sentence.match(/_____/g) || []).length;
    const correctAnswers = exercise.answer.split(',').map(a => a.trim());
    for (let blankIndex = 0; blankIndex < blanksInExercise; blankIndex++) {
      const answerKey = `fib:${exerciseIndex}-${blankIndex}`;
      const userAnswer = userAnswers[answerKey] || '';
      const correctAnswer = correctAnswers[blankIndex] || correctAnswers[0];
      if (normalizeText(userAnswer) !== normalizeText(correctAnswer)) {
        return false;
      }
    }
    return true;
  };

  const getUserAnswersForExercise = (exerciseIndex) => {
    const exercise = exercises[exerciseIndex];
    const blanksInExercise = (exercise.sentence.match(/_____/g) || []).length;
    const answers = [];
    for (let blankIndex = 0; blankIndex < blanksInExercise; blankIndex++) {
      const answerKey = `fib:${exerciseIndex}-${blankIndex}`;
      answers.push(userAnswers[answerKey] || '(no answer)');
    }
    return answers.join(', ');
  };

  const showNextHint = (exerciseIndex) => {
    const currentHints = visibleHints[exerciseIndex] || 0;
    setVisibleHints({
      ...visibleHints,
      [exerciseIndex]: currentHints + 1
    });
  };

  const toggleContext = (exerciseIndex) => {
    setShowContext({
      ...showContext,
      [exerciseIndex]: !showContext[exerciseIndex]
    });
  };

  const requestExplanation = async (index) => {
    const signal = chapterPool.current.signal;
    if (explanations[index]) return;
    setLoadingExplanation({ ...loadingExplanation, [index]: true });
    const exercise = exercises[index];
    const userAnswer = getUserAnswersForExercise(index);
    try {
      const response = await apiFetch('/api/explain', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, exercise, userAnswer })
      });
      const data = await response.json();
      if (signal.aborted) return;
      setExplanations({
        ...explanations,
        [index]: data.explanation
      });
    } catch (error) {
      if (signal.aborted) return;
      console.error('Error getting explanation:', error);
      setExplanations({
        ...explanations,
        [index]: 'Error loading explanation. Please try again.'
      });
    } finally {
      if (!signal.aborted) setLoadingExplanation({ ...loadingExplanation, [index]: false });
    }
  };

  const generateRecommendation = async () => {
    const signal = chapterPool.current.signal;
    setLoadingRecommendation(true);
    const score = getScore();
    const percentage = score.total > 0 ? (score.correct / score.total) * 100 : 0;
    // Diagnostics use the same item scorers and answer keys as Check Answers.
    const wrongExercises = lesson ? collectWrongExercises(lesson, orchestratorValues, strictAccents) : [];
    if (!lesson) {
      exercises.forEach((exercise, index) => {
        if (!isExerciseCorrect(index)) {
          wrongExercises.push({
            exercise: exercise.sentence,
            correct: exercise.answer,
            userAnswer: getUserAnswersForExercise(index)
          });
        }
      });
    }
    try {
      const response = await apiFetch('/api/recommend', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, score, percentage, wrongExercises })
      });
      const data = await response.json();
      if (signal.aborted) return;
      setRecommendation(data);
    } catch (error) {
      if (signal.aborted) return;
      setErrorMsg(error.message || 'Could not get an AI recommendation. Please try again.');
    } finally {
      if (!signal.aborted) setLoadingRecommendation(false);
    }
  };

  const practiceRecommendedTopic = () => {
    if (recommendation && recommendation.recommendation) {
      setExercises([]);
      const nextTopic = String(recommendation.recommendation || '').trim();
      if (!nextTopic) return;
      generateLessonContent(nextTopic);
    }
  };

  const reset = () => {
    resetLessonWork();
    setTopic('');
    setExercises([]);
    setUserAnswers({});
    setSubmitted(false);
    setExplanations({});
    setRecommendation(null);
    setVisibleHints({});
    setShowContext({});
    setLesson(null);
    setOrchestratorValues({});
  };

  const score = getScore();

  return (
    <div className="w-full min-w-0 max-w-4xl mx-auto p-4 sm:p-6 bg-white rounded-lg shadow-lg">
      {/* Pre-lesson tour (language selection) */}
      {!languageContext && onboarding.activeTour === 'pre' && (
        <Joyride
          key={`pre:${onboarding.runId}`}
          steps={preTourSteps.map(step => ({ ...step, disableBeacon: true }))}
          run
          continuous
          showSkipButton
          showProgress
          disableScrolling={false}
          scrollToFirstStep
          locale={{ last: 'Finish' }}
          spotlightPadding={8}
          callback={onboarding.onCallback}
        />
      )}

      {/* Post-lesson tour (in-lesson/exercises) */}
      {languageContext && onboarding.activeTour === 'post' && (
        <Joyride
          key={`post:${onboarding.runId}`}
          steps={postTourSteps.map(step => ({ ...step, disableBeacon: true }))}
          run
          continuous
          showSkipButton
          showProgress
          disableScrolling={false}
          scrollToFirstStep
          locale={{ last: 'Finish' }}
          spotlightPadding={8}
          callback={onboarding.onCallback}
        />
      )}

      {/* Floating help button */}
      <button
        type="button"
        aria-label="Help and tutorial"
        onClick={() => setIsHelpOpen(true)}
        className="fixed bottom-6 right-6 z-40 bg-blue-600 hover:bg-blue-700 text-white rounded-full p-3 shadow-lg"
      >
        <HelpCircle size={22} />
      </button>

      {/* Help modal */}
      {isHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setIsHelpOpen(false)} />
          <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">How this app works</h3>
            <ul className="list-disc pl-5 space-y-2 text-sm text-gray-700">
            <li>Once you've set your language and level, and chosen your topic, click "Start Lesson" to generate an explanation and start practicing. </li>
              <li>Generate exercises using the buttons in the "Add content" panel under the explanation.</li>
              <li>Exercises appear below the explanation. Generating content uses your ChatGPT plan allowance.</li>
              <li>Click <strong>Check Answers</strong> at the bottom to see feedback and get recommendations.</li>
              <li>Use <strong>Export PDF</strong> in the lesson header to download a worksheet with solutions.</li>
              <li>To change the exercise topic, just reload your browser and start a new lesson.</li>
            <li>
              <strong>Privacy:</strong> Your lesson requests are sent to OpenAI using your ChatGPT connection. Generated content is cached separately for your account. Checking answers also sends your mistakes to OpenAI for a learning recommendation. Disconnect in Account settings to end your session.
            </li>
            </ul>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={() => setIsHelpOpen(false)} className="px-3 py-2 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50">Close</button>
              <button
                onClick={() => {
                  setIsHelpOpen(false);
                  onboarding.start();
                }}
                className="px-3 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700"
              >
                Start tutorial
              </button>
            </div>
          </div>
        </div>
      )}
      {!languageContext ? (
        <LanguageLevelSelector onStart={handleLanguageLevelStart} />
      ) : (
        <>
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-800 mb-2 flex items-center gap-2">
              <BookOpen className="text-blue-600" />
              {getLanguageDisplayName(languageContext.language)} Practice with AI
            </h1>
            <p className="text-gray-600">
              Practice {getLanguageDisplayName(languageContext.language)} with AI-generated exercises tailored to your {languageContext.level} level
              {languageContext.challengeMode && ' (Challenge Mode)'}
            </p>
            <div className="mt-3 flex items-center gap-4 text-sm text-gray-600">
              <span className="flex items-center gap-2">
                <Globe className="text-blue-600" size={16} />
                {getLanguageDisplayName(languageContext.language)}
              </span>
              <span className="text-gray-400">•</span>
              <span className="flex items-center gap-2">
                <GraduationCap className="text-green-600" size={16} />
                {languageContext.level}
              </span>
              {languageContext.challengeMode && (
                <>
                  <span className="text-gray-400">•</span>
                  <span className="text-amber-600 font-medium">Challenge Mode</span>
                </>
              )}
            </div>
          </div>

          {errorMsg && (
            <div role="alert" className="mb-4 bg-red-50 text-red-700 border border-red-200 p-3 rounded">{errorMsg}</div>
          )}
          {(loadingLesson || loadingExplOnly) && (
            <p role="status" className="mb-4 flex items-center gap-2 text-sm text-blue-700"><RefreshCw size={16} className="animate-spin" />Generating your explanation…</p>
          )}
          {!lesson ? (
            <div className="space-y-4">
              
              {loadingLesson ? (
                <div className="text-left py-12">
                  <RefreshCw className="animate-spin mx-auto text-blue-600 mb-4" size={32} />
                  <h3 className="text-xl font-semibold text-gray-800 mb-2">Generating your lesson...</h3>
                  <p className="text-gray-600">Creating explanation  for "{topic}". Once the explanation loads, you can create on-demand exercises using the buttons at the top and check your answers at the bottom.</p>
                  <p className="text-gray-600">Please be aware that the AI may create gibberish or plausible sounding but incorrect content. Please check the explanation and exercises carefully.</p>
                  <p className="text-gray-600">Generation time depends on your selected model.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-blue-50 p-4 rounded-lg">
                    <h3 className="text-lg font-semibold text-blue-900 mb-2">Ready to start your lesson?</h3>
                    <p className="text-blue-700">
                      Topic: <strong>{topic}</strong>
                    </p>
                    <p className="text-sm text-blue-600 mt-1">
                      Click "Start Lesson" below to begin with an explanation and exercises.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-700">Settings</label>
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="strictAccents"
                        checked={strictAccents}
                        onChange={(e) => setStrictAccents(e.target.checked)}
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      />
                      <label htmlFor="strictAccents" className="text-sm text-gray-700">
                        Strict accent checking (á ≠ a)
                      </label>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="showAccentBar"
                        checked={showAccentBar}
                        onChange={(e) => setShowAccentBar(e.target.checked)}
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      />
                      <label htmlFor="showAccentBar" className="text-sm text-gray-700">
                        Show accent toolbar
                      </label>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <button
                      onClick={generateLessonContent}
                      disabled={loadingLesson || !topic.trim()}
                      className="w-full bg-purple-600 text-white py-3 px-6 rounded-lg hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                    >
                      {loadingLesson ? (
                        <>
                          <RefreshCw className="animate-spin" size={20} />
                          Starting lesson with explanation...
                        </>
                      ) : (
                        <>
                          <Send size={20} />
                          Start Lesson 
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="bg-blue-50 p-4 rounded-lg">
                <h2 className="text-lg font-semibold text-blue-900 mb-1">Topic: {topic}</h2>
                <p className="text-sm text-blue-700">Complete the sentences by filling in the blanks</p>
                {!strictAccents && (
                  <p className="text-xs text-blue-600 mt-1">Accent marks are optional (á = a)</p>
                )}
              </div>

              {showAccentBar && (
                <div className="bg-gray-100 p-3 rounded-lg">
                  <p className="text-xs text-gray-600 mb-2">Click to insert accented characters:</p>
                  <div className="flex flex-wrap gap-2">
                    {['á', 'é', 'í', 'ó', 'ú', 'ñ', 'ü', '¿', '¡'].map((char) => (
                      <button
                        key={char}
                        onClick={() => insertAccent(char)}
                        className="px-3 py-1 bg-white border border-gray-300 rounded hover:bg-gray-50 text-lg font-medium"
                      >
                        {char}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 mt-2">Tip: Click in an input field first, then click the character to insert</p>
                </div>
              )}

              <div className="space-y-4">
                {renderLessonPanel()}
                {!lesson && exercises.map((exercise, index) => {
                  const isCorrect = submitted && isExerciseCorrect(index);
                  const hasWrongAnswer = submitted && !isCorrect;
                  const visibleHintCount = visibleHints[index] || 0;
                  const availableHints = exercise.hints?.filter(h => h) || [];
                  return (
                    <div key={index} className="border rounded-lg p-4 space-y-3">
                      <div className="flex items-start gap-3">
                        <span className="text-sm font-medium text-gray-500 mt-1">{index + 1}.</span>
                        <div className="flex-1 space-y-2">
                          <div className="text-gray-800 leading-relaxed">
                            {parseExerciseSentence(exercise.sentence, index)}
                          </div>
                          {!submitted && availableHints.length > 0 && (
                            <div className="space-y-2">
                              {visibleHintCount > 0 && (
                                <div className="space-y-1">
                                  {availableHints.slice(0, visibleHintCount).map((hint, hintIndex) => (
                                    <div key={hintIndex} className="text-sm text-blue-700 bg-blue-50 p-2 rounded flex items-start gap-2">
                                      <HelpCircle size={14} className="mt-0.5 flex-shrink-0" />
                                      <span>{hint}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {visibleHintCount < availableHints.length && (
                                <button
                                  onClick={() => showNextHint(index)}
                                  className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
                                >
                                  <HelpCircle size={14} />
                                  {visibleHintCount === 0 ? 'Need a hint?' : `Show hint ${visibleHintCount + 1}/${availableHints.length}`}
                                </button>
                              )}
                            </div>
                          )}
                          {exercise.context && (
                            <div className="mt-2">
                              <button
                                onClick={() => toggleContext(index)}
                                className="text-sm text-purple-600 hover:text-purple-800 flex items-center gap-1"
                              >
                                <Info size={14} />
                                {showContext[index] ? 'Hide' : 'Show'} cultural context
                              </button>
                              {showContext[index] && (
                                <div className="mt-2 text-sm text-purple-700 bg-purple-50 p-3 rounded">
                                  {exercise.context}
                                </div>
                              )}
                            </div>
                          )}
                          {submitted && hasWrongAnswer && (
                            <button
                              onClick={() => requestExplanation(index)}
                              disabled={loadingExplanation[index]}
                              className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1 mt-2"
                            >
                              <ChevronRight size={14} />
                              {loadingExplanation[index] ? 'Loading explanation...' : 
                               explanations[index] ? 'Show explanation' : 'Why is this wrong?'}
                            </button>
                          )}
                          {explanations[index] && (
                            <div className="mt-3 p-4 bg-gray-50 rounded-md text-sm text-gray-700">
                              {parseMarkdown(explanations[index])}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {!submitted ? (
                <button
                  id="check-answers-button"
                  onClick={checkAnswers}
                  className="w-full bg-green-600 text-white py-3 px-6 rounded-lg hover:bg-green-700 transition-colors"
                >
                  Check Answers & Get Feedback
                </button>
              ) : (
                <div className="space-y-4">
                  <div className="bg-gray-100 p-4 rounded-lg text-center">
                    <p className="text-2xl font-bold text-gray-800">
                      Score: {score.correct}/{score.total}
                    </p>
                    <p className="text-gray-600">
                      {score.correct === score.total ? '¡Excelente! Perfect score!' :
                       score.correct >= score.total * 0.8 ? '¡Muy bien! Great job!' :
                       score.correct >= score.total * 0.6 ? 'Good effort! Keep practicing!' :
                       'Keep studying! You\'ll get there!'}
                    </p>
                  </div>
                  <button
                    onClick={generateRecommendation}
                    disabled={loadingRecommendation}
                    className="w-full bg-green-600 text-white py-3 px-6 rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                  >
                    {loadingRecommendation ? 'Getting feedback…' : 'Update AI Feedback'}
                  </button>
                  {recommendation && (
                    <div className="bg-amber-50 border border-amber-200 p-4 rounded-lg">
                      <div className="flex items-start gap-3">
                        <Lightbulb className="text-amber-600 mt-1" size={20} />
                        <div className="flex-1">
                          <h3 className="font-semibold text-amber-900 mb-1">AI Recommendation</h3>
                          <p className="text-sm text-amber-800 mb-2">{recommendation.reasoning}</p>
                          <p className="text-sm font-medium text-amber-900 mb-3">
                            Suggested topic: <strong>{recommendation.recommendation}</strong>
                          </p>
                          <button
                            onClick={practiceRecommendedTopic}
                            className="bg-amber-600 text-white px-4 py-2 rounded-md hover:bg-amber-700 transition-colors text-sm"
                          >
                            Practice This Topic
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  {loadingRecommendation && (
                    <div className="bg-gray-50 p-4 rounded-lg text-center">
                      <RefreshCw className="animate-spin mx-auto text-gray-600" size={20} />
                      <p className="text-sm text-gray-600 mt-2">Analyzing your performance...</p>
                    </div>
                  )}
                                <button
                onClick={resetToLanguageSelection}
                className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
              >
                <RefreshCw size={20} />
                Choose Different Language/Level
              </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AIPracticeApp;
