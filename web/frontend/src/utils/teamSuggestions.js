// Each field owns its debounce timer and request so editing one never cancels the other.
export function createTeamSuggestions({
    apiBaseUrl = '', onState, fetchImpl = fetch,
    setTimer = setTimeout, clearTimer = clearTimeout
}) {
    let state = { value: '', selectedId: null, teams: [], loading: false, error: null, open: false, activeIndex: -1 };
    let timer = null;
    let active = null;
    let generation = 0;

    function publish(patch) {
        state = { ...state, ...patch };
        onState(state);
    }

    function cancel() {
        generation++;
        if (timer !== null) clearTimer(timer);
        timer = null;
        active?.abort();
        active = null;
    }

    async function load(query, version) {
        timer = null;
        const controller = new AbortController();
        active = controller;
        publish({ loading: true });
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
            const response = await fetchImpl(`${apiBaseUrl}/api/team-search?${new URLSearchParams({ q: query })}`, { signal });
            const data = await response.json();
            if (!response.ok || !data.success || !Array.isArray(data.teams)) throw new Error('Takım önerileri yüklenemedi.');
            if (version !== generation) return;
            const teams = data.teams.filter(team => typeof team?.id === 'string' && typeof team.name === 'string').slice(0, 8);
            publish({ teams, loading: false, error: null, open: teams.length > 0, activeIndex: -1 });
        } catch (error) {
            if (version === generation && !controller.signal.aborted) {
                publish({ teams: [], loading: false, open: false, activeIndex: -1,
                    error: error.name === 'TimeoutError' ? 'Takım önerileri zaman aşımına uğradı. İsmi yazarak arayabilirsiniz.'
                        : 'Takım önerileri yüklenemedi. İsmi yazarak arayabilirsiniz.' });
            }
        }
    }

    function select(id) {
        const team = state.teams.find(item => item.id === id);
        if (!team) return false;
        cancel();
        publish({ value: team.name, selectedId: team.id, teams: [], open: false, activeIndex: -1, loading: false, error: null });
        return true;
    }

    return {
        edit(value) {
            cancel();
            publish({ value, selectedId: null, teams: [], loading: false, error: null, open: false, activeIndex: -1 });
            const query = value.trim();
            if (query.length >= 2) {
                const version = generation;
                timer = setTimer(() => load(query, version), 300);
            }
        },
        replace(value, selectedId = null) {
            cancel();
            publish({ value, selectedId, teams: [], loading: false, error: null, open: false, activeIndex: -1 });
        },
        clear() {
            cancel();
            publish({ value: '', selectedId: null, teams: [], loading: false, error: null, open: false, activeIndex: -1 });
        },
        navigate(direction) {
            if (!state.teams.length) return;
            const index = state.activeIndex < 0 ? (direction > 0 ? 0 : state.teams.length - 1)
                : (state.activeIndex + direction + state.teams.length) % state.teams.length;
            publish({ open: true, activeIndex: index });
        },
        acceptActive() {
            return state.open && state.activeIndex >= 0 ? select(state.teams[state.activeIndex].id) : false;
        },
        select,
        focus() {
            if (state.teams.length) publish({ open: true });
        },
        dismiss() {
            cancel();
            publish({ open: false, loading: false, activeIndex: -1 });
        },
        dispose: cancel
    };
}

// Move only the list's viewport; scrollIntoView can also move the page or H2H panel.
export function keepSuggestionVisible(list, option) {
    if (!list || !option) return;
    const top = list.getBoundingClientRect().top + list.clientTop;
    const bottom = top + list.clientHeight;
    const row = option.getBoundingClientRect();
    if (row.top < top) list.scrollTop += row.top - top;
    else if (row.bottom > bottom) list.scrollTop += row.bottom - bottom;
}
