import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Palette } from 'lucide-react';
import { applyTheme, normalizeTheme, readStoredTheme, THEMES } from '../utils/theme';

export default function ThemeSelector() {
  const [theme, setTheme] = useState(() => normalizeTheme(
    globalThis.document?.documentElement.getAttribute('data-theme') || readStoredTheme()
  ));
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(() => THEMES.findIndex(item => item.id === theme));
  const container = useRef(null);
  const trigger = useRef(null);
  const options = useRef([]);
  const pendingFocus = useRef(null);
  const menuId = useId();
  const selectedIndex = THEMES.findIndex(item => item.id === theme);

  useLayoutEffect(() => {
    if (open && pendingFocus.current !== null) {
      options.current[pendingFocus.current]?.focus();
      pendingFocus.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event) {
      if (!container.current?.contains(event.target)) setOpen(false);
    }
    function escape(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        pendingFocus.current = null;
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function openWithFocus(index) {
    setFocusIndex(index);
    if (open) options.current[index]?.focus();
    else {
      pendingFocus.current = index;
      setOpen(true);
    }
  }

  function closeMenu(returnFocus = false) {
    pendingFocus.current = null;
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }

  function selectTheme(value) {
    setTheme(applyTheme(value));
    setFocusIndex(THEMES.findIndex(item => item.id === value));
    closeMenu(true);
  }

  function handleMenuKeyDown(event) {
    const current = options.current.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (current + 1) % THEMES.length;
    if (event.key === 'ArrowUp') next = (current + THEMES.length - 1) % THEMES.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = THEMES.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      setFocusIndex(next);
      options.current[next]?.focus();
    }
  }

  return (
    <div className="theme-selector" ref={container}
      onPointerEnter={event => {
        if (event.pointerType === 'mouse' && !open) {
          setFocusIndex(selectedIndex);
          setOpen(true);
        }
      }}
      onPointerLeave={event => {
        if (event.pointerType === 'mouse' && !container.current?.contains(document.activeElement)) closeMenu();
      }}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) closeMenu();
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          closeMenu(true);
        }
      }}>
      <button type="button" className="theme-trigger" ref={trigger}
        aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
        aria-label={`Tema seç. Seçili: ${THEMES[selectedIndex].label}`}
        onClick={() => {
          if (open) closeMenu();
          else {
            setFocusIndex(selectedIndex);
            setOpen(true);
          }
        }}
        onKeyDown={event => {
          if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            openWithFocus(event.key === 'ArrowDown' ? 0 : event.key === 'ArrowUp' ? THEMES.length - 1 : selectedIndex);
          }
        }}>
        <Palette size={18} aria-hidden="true" /><span>Tema</span><ChevronDown size={16} aria-hidden="true" />
      </button>
      <div className="theme-popover" hidden={!open}>
        <div id={menuId} className="theme-menu" role="menu" aria-label="Tema seçenekleri" onKeyDown={handleMenuKeyDown}>
          {THEMES.map((item, index) => (
            <button key={item.id} type="button" role="menuitemradio" aria-checked={theme === item.id}
              className="theme-option" tabIndex={focusIndex === index ? 0 : -1}
              ref={element => { options.current[index] = element; }}
              onFocus={() => setFocusIndex(index)} onClick={() => selectTheme(item.id)}>
              <span className={`theme-swatch theme-swatch--${item.id}`} aria-hidden="true" />
              <span>{item.label}</span>
              {theme === item.id && <Check size={17} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
