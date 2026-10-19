import React, { useEffect, useRef } from 'react';
import { keepSuggestionVisible } from '../utils/teamSuggestions';

const squadNames = { main: 'Ana takım', senior: 'Ana takım', men: 'Erkek', women: 'Kadın', female: 'Kadın', reserve: 'Rezerv', reserves: 'Rezerv', youth: 'Genç' };

export default function TeamSearchInput({ id, label, placeholder, state, controller, inputRef }) {
  const listId = `${id}-suggestions`;
  const listRef = useRef(null);
  useEffect(() => {
    if (state.open && state.activeIndex >= 0) {
      keepSuggestionVisible(listRef.current, listRef.current?.children[state.activeIndex]);
    }
  }, [state.open, state.activeIndex]);
  function handleKeyDown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      controller.navigate(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && controller.acceptActive()) {
      event.preventDefault();
    } else if (event.key === 'Escape') {
      if (state.open || state.loading) event.preventDefault();
      controller.dismiss();
    }
  }

  return <div className="match-search-field team-search-field">
    <label htmlFor={id} className="team-search-label">{label}</label>
    <input id={id} ref={inputRef} type="text" role="combobox" autoComplete="off"
      className="team-search-input" placeholder={placeholder} value={state.value}
      aria-autocomplete="list" aria-expanded={state.open} aria-controls={listId}
      aria-activedescendant={state.open && state.activeIndex >= 0 ? `${listId}-${state.activeIndex}` : undefined}
      aria-describedby={`${id}-suggestion-status`}
      onChange={event => controller.edit(event.target.value)} onKeyDown={handleKeyDown}
      onFocus={() => controller.focus()} onBlur={() => controller.dismiss()} />
    <span id={`${id}-suggestion-status`} className="sr-only" role="status" aria-live="polite">
      {state.loading ? 'Takım önerileri yükleniyor.' : state.error || (state.selectedId ? 'Takım seçildi.'
        : state.open ? `${state.teams.length} takım önerisi. Ok tuşlarıyla seçebilirsiniz.` : '')}
    </span>
    {state.open && <ul ref={listRef} id={listId} role="listbox" aria-label={`${label} takım önerileri`} className="team-suggestions">
      {state.teams.map((team, index) => <li key={team.id} id={`${listId}-${index}`} role="option"
        aria-selected={state.activeIndex === index} className="team-suggestion"
        onPointerDown={event => event.preventDefault()}
        onClick={() => controller.select(team.id)}>
        <span className="team-suggestion-name">{team.name}</span>
        <span className="team-suggestion-detail">{[squadNames[team.squad] || team.squad, team.country].filter(Boolean).join(' · ')}</span>
      </li>)}
    </ul>}
  </div>;
}
