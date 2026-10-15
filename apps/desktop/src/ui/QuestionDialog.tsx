/** Question dialog — ask_question tool surface. */

import { useState } from 'react';
import { palette } from './theme.js';
import type { QuestionView } from '../lib/transcript.js';

export function QuestionDialog({
  view,
  onAnswer,
}: {
  view: QuestionView;
  onAnswer: (answers: Array<{ question: string; answers: string[] }>) => void;
}) {
  const [answers, setAnswers] = useState<string[]>(view.questions.map(() => ''));

  const update = (index: number, value: string): void => {
    setAnswers((current) => current.map((entry, i) => (i === index ? value : entry)));
  };

  const submit = (): void => {
    onAnswer(
      view.questions.map((question, index) => ({
        question: question.question,
        answers: (answers[index] ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      })),
    );
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ width: 540, maxWidth: '92vw', background: palette.bg.elevated, border: `1px solid ${palette.accent.primary}`, borderRadius: 10, padding: 18 }}>
        <div style={{ color: palette.accent.primary, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>The agent has questions</div>
        {view.questions.map((question, index) => (
          <div key={index} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: palette.text.primary, marginBottom: 4 }}>{question.question}</div>
            {question.options && question.options.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                {question.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => update(index, option.label)}
                    style={{ background: palette.fill.secondary, color: palette.text.secondary, border: `1px solid ${palette.stroke.secondary}`, borderRadius: 12, padding: '3px 10px', fontSize: 11, cursor: 'pointer' }}
                    title={option.description}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
            <input
              value={answers[index] ?? ''}
              onChange={(event) => update(index, event.target.value)}
              placeholder="type an answer (comma-separate multiple)"
              style={{ width: '100%', boxSizing: 'border-box', background: palette.bg.editor, border: `1px solid ${palette.stroke.primary}`, borderRadius: 6, color: palette.text.primary, padding: '7px 10px', fontSize: 12, outline: 'none' }}
            />
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button type="button" onClick={submit} style={{ background: palette.accent.control, color: palette.text.primary, border: `1px solid ${palette.stroke.primary}`, borderRadius: 6, padding: '7px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            Submit answers
          </button>
        </div>
      </div>
    </div>
  );
}
