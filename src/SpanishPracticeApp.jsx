import React, { useState } from 'react';
import { BookOpen, Send, Check, X, RefreshCw, HelpCircle, Lightbulb, Info, ChevronRight, Globe, GraduationCap } from 'lucide-react';
import Orchestrator, { scoreLesson, generateLesson } from './exercises/Orchestrator.jsx';
import { scoreFIB, generateFIB } from './exercises/FIBExercise.jsx';
import { scoreMCQ, generateMCQ } from './exercises/MCQExercise.jsx';
import { scoreCloze, generateCloze } from './exercises/ClozeExercise.jsx';
import { scoreClozeMixed, generateClozeMixed } from './exercises/ClozeMixedExercise.jsx';
import { generateExplanation } from './exercises/ExplanationComponent.jsx';
import { normalizeText as normalizeTextUtil } from './exercises/utils.js';
import LanguageLevelSelector from './LanguageLevelSelector.jsx';

const SpanishPracticeApp = () => {
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
  const [mcqCount, setMcqCount] = useState(5);
  const [clozeCount, setClozeCount] = useState(2);
  const [clozeMixCount, setClozeMixCount] = useState(2);

  const normalizeText = (text) => normalizeTextUtil(text, strictAccents);

  // Helper function to get language display name
  const getLanguageDisplayName = (languageName) => {
    // If it's a known language code, return the proper name
    const languageMap = {
      'es': 'Spanish',
      'fr': 'French', 
      'de': 'German',
      'it': 'Italian',
      'pt': 'Portuguese',
      'en': 'English',
      'ja': 'Japanese',
      'ko': 'Korean',
      'zh': 'Chinese',
      'ru': 'Russian',
      'hu': 'Hungarian',
    };
    
    // If it's a known code, return the proper name
    if (languageMap[languageName]) {
      return languageMap[languageName];
    }
    
    // Otherwise, capitalize the first letter and return as-is
    return languageName.charAt(0).toUpperCase() + languageName.slice(1);
  };

  // Handle language and level selection
  const handleLanguageLevelStart = async (context) => {
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
      setLesson(null);
      try {
        const data = await generateLesson(context.topic, {
          fill_in_blanks: 0,
          multiple_choice: 0,
          cloze_passages: 0,
          cloze_with_mixed_options: 0
        }, context);
        setLesson(data);
        setOrchestratorValues({});
      } catch (error) {
        console.error('Error generating lesson:', error);
        setErrorMsg(error.message || 'Error generating lesson. Please try again.');
      } finally {
        setLoadingLesson(false);
      }
    }
  };

  // Reset to language selection
  const resetToLanguageSelection = () => {
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

  const parseMarkdown = (text) => {
    const parts = text.split(/```/);
    return parts.map((part, index) => {
      if (index % 2 === 1) {
        return (
          <pre key={index} className="bg-gray-800 text-gray-100 p-3 rounded-md my-2 overflow-x-auto">
            <code>{part.replace(/^\w+\n/, '')}</code>
          </pre>
        );
      }
      const lines = part.split('\n');
      return lines.map((line, lineIndex) => {
        if (line.match(/^###\s/)) {
          return (
            <h3 key={`${index}-${lineIndex}`} className="font-bold text-lg mt-3 mb-1">
              {line.substring(4)}
            </h3>
          );
        } else if (line.match(/^##\s/)) {
          return (
            <h2 key={`${index}-${lineIndex}`} className="font-bold text-xl mt-3 mb-1">
              {line.substring(3)}
            </h2>
          );
        }
        let processedLine = line
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>')
          .replace(/`(.*?)`/g, '<code class="bg-gray-200 px-1 py-0.5 rounded text-sm">$1</code>')
          .replace(/"([^"]+)":/g, '<strong>"$1"</strong>:');
        if (line.match(/^\d+\.\s/)) {
          return (
            <div key={`${index}-${lineIndex}`} className="ml-4 my-1">
              <span dangerouslySetInnerHTML={{ __html: processedLine }} />
            </div>
          );
        } else if (line.match(/^[-•]\s/)) {
          return (
            <div key={`${index}-${lineIndex}`} className="ml-4 my-1">
              <span dangerouslySetInnerHTML={{ __html: '• ' + processedLine.substring(2) }} />
            </div>
          );
        } else if (line.trim() === '') {
          return <br key={`${index}-${lineIndex}`} />;
        } else {
          return (
            <div key={`${index}-${lineIndex}`} className="my-1">
              <span dangerouslySetInnerHTML={{ __html: processedLine }} />
            </div>
          );
        }
      });
    });
  };

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
            disabled={submitted}
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

  const renderLessonPanel = () => (
    lesson && (
      <div className="border rounded-lg p-4 space-y-3">
        <h2 className="text-xl font-semibold text-gray-800">Lesson: {lesson.topic}</h2>
        {lesson.pedagogy?.strategy_notes && (
          <p className="text-sm text-gray-600">Approach: scaffolded+spiral — {lesson.pedagogy.strategy_notes}</p>
        )}
        {/* On-demand exercise generation controls inside the lesson */}
        <div className="mt-3 p-3 bg-gray-50 rounded">
          <div className="font-semibold text-gray-800 mb-2">Add content</div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 items-center">
            <button
              onClick={generateExplanationOnly}
              disabled={loadingExplOnly || !topic.trim()}
              className="w-full bg-gray-800 text-white py-2 px-4 rounded hover:bg-gray-900 text-sm"
            >{loadingExplOnly ? 'Generating...' : 'Generate Explanation'}</button>

            <div className="flex gap-2">
              <button
                onClick={generateFIBOnly}
                disabled={loadingFibOnly || !topic.trim()}
                className="flex-1 bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 text-sm"
              >{loadingFibOnly ? 'Generating...' : `Add FIB (${exerciseCount})`}</button>
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
              >{loadingClozeOnly ? 'Generating...' : `Add Cloze (${clozeCount})`}</button>
              <input type="number" min={1} max={10} value={clozeCount} onChange={e => setClozeCount(e.target.value)} className="w-16 px-2 py-1 border rounded text-sm" />
            </div>

            <div className="flex gap-2">
              <button
                onClick={generateClozeMixOnly}
                disabled={loadingClozeMixOnly || !topic.trim()}
                className="flex-1 bg-fuchsia-600 text-white py-2 px-4 rounded hover:bg-fuchsia-700 text-sm"
              >{loadingClozeMixOnly ? 'Generating...' : `Add Cloze-Mixed (${clozeMixCount})`}</button>
              <input type="number" min={1} max={10} value={clozeMixCount} onChange={e => setClozeMixCount(e.target.value)} className="w-16 px-2 py-1 border rounded text-sm" />
            </div>
          </div>
        </div>
        <Orchestrator
          lesson={lesson}
          values={orchestratorValues}
          onChange={(key, val) => setOrchestratorValues(prev => ({ ...prev, [key]: val }))}
          checked={submitted}
          strictAccents={strictAccents}
          idBase="lesson"
          onFocusKey={(k) => setLastFocusedInput(k)}
        />
      </div>
    )
  );

  const generateExercises = async () => {
    if (!topic.trim()) return;
    setLoading(true);
    setErrorMsg('');
    setSubmitted(false);
    setUserAnswers({});
    setExplanations({});
    setRecommendation(null);
    setVisibleHints({});
    setShowContext({});
    setLesson(null);
    try {
      const response = await fetch('/api/generate-exercises', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, exerciseCount: Number(exerciseCount) })
      });
      const data = await response.json();
      if (!response.ok) {
        setErrorMsg(data.details || data.error || 'Failed to generate exercises');
        return;
      }
      setExercises(data.exercises || []);
    } catch (error) {
      console.error('Error generating exercises:', error);
      alert('Error generating exercises. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const generateLessonContent = async (t) => {
    const topicToUse = (typeof t === 'string' && t.trim()) ? t.trim() : String(topic || '').trim();
    if (!topicToUse) return;
    setLoadingLesson(true);
    setErrorMsg('');
    setLesson(null);
    try {
      // Only generate explanation initially - exercises generated on-demand
      const data = await generateLesson(topicToUse, {
        fill_in_blanks: 0,
        multiple_choice: 0,
        cloze_passages: 0,
        cloze_with_mixed_options: 0
      }, languageContext);
      setTopic(topicToUse);
      setLesson(data);
      setOrchestratorValues({});
    } catch (error) {
      console.error('Error generating lesson:', error);
      setErrorMsg(error.message || 'Error generating lesson. Please try again.');
    } finally {
      setLoadingLesson(false);
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
    cloze_with_mixed_options: lesson?.cloze_with_mixed_options || []
  });

  const mergeLesson = (partial) => {
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
  };

  const generateExplanationOnly = async () => {
    if (!topic.trim()) return;
    setLoadingExplOnly(true);
    setErrorMsg('');
    try {
      const explanation = await generateExplanation(topic, languageContext);
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, explanation });
    } catch (e) { console.error(e); setErrorMsg('Failed to generate explanation'); }
    finally { setLoadingExplOnly(false); }
  };

  const generateFIBOnly = async () => {
    if (!topic.trim()) return;
    setLoadingFibOnly(true);
    setErrorMsg('');
    try {
      const data = await generateFIB(topic, Number(exerciseCount), languageContext);
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, fill_in_blanks: data.items || [] });
    } catch (e) { console.error(e); setErrorMsg('Failed to generate FIB'); }
    finally { setLoadingFibOnly(false); }
  };

  const generateMCQOnly = async () => {
    if (!topic.trim()) return;
    setLoadingMcqOnly(true);
    setErrorMsg('');
    try {
      const data = await generateMCQ(topic, Number(mcqCount), languageContext);
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, multiple_choice: data.items || [] });
      } catch (e) { console.error(e); setErrorMsg('Failed to generate MCQ'); }
    finally { setLoadingMcqOnly(false); }
  };

  const generateClozeOnly = async () => {
    if (!topic.trim()) return;
    setLoadingClozeOnly(true);
    setErrorMsg('');
    try {
      const data = await generateCloze(topic, Number(clozeCount), languageContext);
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, cloze_passages: data.items || [] });
    } catch (e) { console.error(e); setErrorMsg('Failed to generate cloze'); }
    finally { setLoadingClozeOnly(false); }
  };

  const generateClozeMixOnly = async () => {
    if (!topic.trim()) return;
    setLoadingClozeMixOnly(true);
    setErrorMsg('');
    try {
      const data = await generateClozeMixed(topic, Number(clozeMixCount), languageContext);
      if (!lesson) setLesson(ensureLessonSkeleton());
      mergeLesson({ topic, cloze_with_mixed_options: data.items || [] });
      } catch (e) { console.error(e); setErrorMsg('Failed to generate cloze-mixed'); }
    finally { setLoadingClozeMixOnly(false); }
  };

  const handleAnswerChange = (key, value) => {
    setUserAnswers({
      ...userAnswers,
      [key]: value
    });
  };

  const [orchestratorValues, setOrchestratorValues] = useState({});

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
    if (explanations[index]) return;
    setLoadingExplanation({ ...loadingExplanation, [index]: true });
    const exercise = exercises[index];
    const userAnswer = getUserAnswersForExercise(index);
    try {
      const response = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, exercise, userAnswer })
      });
      const data = await response.json();
      setExplanations({
        ...explanations,
        [index]: data.explanation
      });
    } catch (error) {
      console.error('Error getting explanation:', error);
      setExplanations({
        ...explanations,
        [index]: 'Error loading explanation. Please try again.'
      });
    } finally {
      setLoadingExplanation({ ...loadingExplanation, [index]: false });
    }
  };

  const generateRecommendation = async () => {
    setLoadingRecommendation(true);
    const score = getScore();
    const percentage = score.total > 0 ? (score.correct / score.total) * 100 : 0;
    const wrongExercises = [];
    if (lesson) {
      const eq = (a, b) => normalizeText(a) === normalizeText(b);
      const collect = (type, items) => {
        items.forEach((item, idx) => {
          const key = `lesson:${type}:${idx}`;
          const val = orchestratorValues[key];
          let s = { correct: 0, total: 0 };
          if (type === 'fib') s = scoreFIB(item, val || {}, eq);
          if (type === 'mcq') s = scoreMCQ(item, val);
          if (type === 'cloze') s = scoreCloze(item, val || {}, eq);
          if (type === 'clozeMix') s = scoreClozeMixed(item, val || {}, eq);
          if (s.correct < s.total) {
            wrongExercises.push({ type, index: idx, item, userAnswer: val });
          }
        });
      };
      if (Array.isArray(lesson.fill_in_blanks)) collect('fib', lesson.fill_in_blanks);
      if (Array.isArray(lesson.multiple_choice)) collect('mcq', lesson.multiple_choice);
      if (Array.isArray(lesson.cloze_passages)) collect('cloze', lesson.cloze_passages);
      if (Array.isArray(lesson.cloze_with_mixed_options)) collect('clozeMix', lesson.cloze_with_mixed_options);
    } else {
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
      const response = await fetch('/api/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, score, percentage, wrongExercises })
      });
      const data = await response.json();
      setRecommendation(data);
    } catch (error) {
      console.error('Error getting recommendation:', error);
    } finally {
      setLoadingRecommendation(false);
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
    <div className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow-lg">
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

          {!lesson ? (
            <div className="space-y-4">
              {errorMsg && (
                <div className="bg-red-50 text-red-700 border border-red-200 p-3 rounded">
                  {errorMsg}
                </div>
              )}
              
              {loadingLesson ? (
                <div className="text-center py-12">
                  <RefreshCw className="animate-spin mx-auto text-blue-600 mb-4" size={32} />
                  <h3 className="text-xl font-semibold text-gray-800 mb-2">Generating your lesson...</h3>
                  <p className="text-gray-600">Creating explanation and exercises for "{topic}"</p>
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

              {showAccentBar && !submitted && (
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
                  onClick={checkAnswers}
                  className="w-full bg-green-600 text-white py-3 px-6 rounded-lg hover:bg-green-700 transition-colors"
                >
                  Check Answers
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

export default SpanishPracticeApp;


