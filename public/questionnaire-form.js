export function readQuestionnaireAnswers(form, questions) {
  return questions.map((question, index) => {
    const written = form.querySelector(`#written-answer-${index}`)?.value.trim() || '';
    if (!question.choices.length) return written ? { text: written } : null;
    const selected = form.querySelector(`input[name="answer-${index}"]:checked`);
    if (!selected) return null;
    if (selected.value === 'written') return written ? { text: written } : null;
    return Number(selected.value);
  });
}

export function renderQuestionnaireQuestions(list, questions, savedAnswers = [], onProgress = () => {}) {
  list.replaceChildren();
  let currentSection = '';
  questions.forEach((question, index) => {
    if (question.section !== currentSection) {
      currentSection = question.section;
      const heading = document.createElement('h2');
      heading.className = 'question-section';
      heading.textContent = currentSection;
      list.append(heading);
    }
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'question';
    const legend = document.createElement('legend');
    legend.textContent = `${index + 1}. ${question.prompt}`;
    fieldset.append(legend);
    const written = document.createElement('div');
    written.className = 'written-answer';
    written.hidden = question.choices.length > 0 && typeof savedAnswers[index]?.text !== 'string';
    const writtenLabel = document.createElement('label');
    writtenLabel.htmlFor = `written-answer-${index}`;
    writtenLabel.textContent = 'Your written answer (up to 500 characters)';
    const writtenInput = document.createElement('textarea');
    writtenInput.id = `written-answer-${index}`;
    writtenInput.rows = 3;
    writtenInput.maxLength = 500;
    writtenInput.value = typeof savedAnswers[index]?.text === 'string' ? savedAnswers[index].text : '';
    writtenInput.addEventListener('input', onProgress);
    written.append(writtenLabel, writtenInput);
    question.choices.forEach((choice, choiceIndex) => {
      const label = document.createElement('label');
      label.className = 'choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `answer-${index}`;
      input.value = String(choiceIndex);
      input.checked = savedAnswers[index] === choiceIndex;
      input.addEventListener('change', () => { written.hidden = true; onProgress(); });
      const span = document.createElement('span');
      span.textContent = choice;
      label.append(input, span);
      fieldset.append(label);
    });
    if (question.choices.length) {
      const label = document.createElement('label');
      label.className = 'choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `answer-${index}`;
      input.value = 'written';
      input.checked = typeof savedAnswers[index]?.text === 'string';
      input.addEventListener('change', () => {
        written.hidden = false;
        writtenInput.focus();
        onProgress();
      });
      const span = document.createElement('span');
      span.textContent = 'Write my own answer';
      label.append(input, span);
      fieldset.append(label);
    }
    fieldset.append(written);
    list.append(fieldset);
  });
  onProgress();
}
