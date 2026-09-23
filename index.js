import { SlashCommandEnumValue, enumTypes } from '../../../slash-commands/SlashCommandEnumValue.js';

// OOC Memo — SillyTavern extension (전역 메모 전용)
// 메모 저장 / 입력창에 넣기 / 바로 전송 / 검색 / 즐겨찾기 / 태그
// 채팅에서 저장 / 내보내기·가져오기 / 사용 기록 정렬 / 슬래시 커맨드 / 드래그 정렬

const MODULE = 'ooc_memo';
const MOBILE_WIDTH = 768;

const DEFAULTS = {
    memos: [],
    defaultWrap: true,
    oocFormat: '(OOC: {text})',
    insertMode: 'ask',      // replace | append | ask
    pinFavorites: true,
    confirmDelete: true,
    showMesButton: true,
    showSelButton: true,
    macroOnSave: true,      // 채팅에서 저장할 때 이름 → {{char}} / {{user}}
    closeAfterUse: false,   // 모바일에서는 항상 닫힘
    sortBy: 'manual',       // manual | recent | usage | created | title
};

const state = {
    open: false,
    search: '',
    favOnly: false,
    tag: null,
    expanded: new Set(),
    editingId: null,
    savedSelection: '',
    savedSelectionMesId: null,
};

// ───────────────────────── 유틸 ─────────────────────────

const ctx = () => SillyTavern.getContext();
let migrated = false;

function settings() {
    const es = ctx().extensionSettings;
    if (!es[MODULE]) es[MODULE] = {};
    const s = es[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    if (!migrated) {
        // 이전 버전의 캐릭터 전용 정보 제거 → 모두 전역 메모로
        migrated = true;
        for (const m of s.memos) {
            delete m.scope;
            delete m.scopeName;
        }
    }
    return s;
}

const save = () => ctx().saveSettingsDebounced();

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const isMobile = () => window.innerWidth <= MOBILE_WIDTH;

function parseTags(str) {
    return [...new Set(String(str ?? '').split(/[,，]/).map(t => t.trim().replace(/^#/, '')).filter(Boolean))];
}

function displayTitle(m) {
    if (m.title?.trim()) return m.title.trim();
    const first = (m.content || '').trim().split('\n')[0];
    if (!first) return '(빈 메모)';
    return first.length > 40 ? first.slice(0, 40) + '…' : first;
}

/** true = 확인, false = 두 번째 버튼, null = 닫힘 */
async function askConfirm(message, okText = '확인', cancelText = '취소') {
    const c = ctx();
    if (typeof c.callGenericPopup === 'function' && c.POPUP_TYPE) {
        const R = c.POPUP_RESULT ?? { AFFIRMATIVE: 1, NEGATIVE: 0 };
        const r = await c.callGenericPopup(esc(message), c.POPUP_TYPE.CONFIRM, '', {
            okButton: okText,
            cancelButton: cancelText,
        });
        if (r === R.AFFIRMATIVE) return true;
        if (r === R.NEGATIVE) return false;
        return null;
    }
    return window.confirm(message);
}

// ───────────────────────── 데이터 ─────────────────────────

function normalizeMemo(r) {
    if (!r || typeof r !== 'object') return null;
    const content = String(r.content ?? r.text ?? '');
    if (!content.trim()) return null;
    const now = Date.now();
    return {
        id: String(r.id || uid()),
        title: String(r.title ?? ''),
        content,
        tags: Array.isArray(r.tags) ? parseTags(r.tags.join(',')) : parseTags(r.tags),
        favorite: !!r.favorite,
        wrap: r.wrap === undefined ? settings().defaultWrap : !!r.wrap,
        useCount: Number(r.useCount) || 0,
        lastUsed: Number(r.lastUsed) || 0,
        createdAt: Number(r.createdAt) || now,
        updatedAt: Number(r.updatedAt) || now,
    };
}

const getMemo = id => settings().memos.find(m => m.id === id);

const KOREAN_PARTICLE_RULES = [
    { forms: ['은/는', '은(는)', '(은)는', '은', '는'], batchim: '은', vowel: '는' },
    { forms: ['이/가', '이(가)', '(이)가', '이', '가'], batchim: '이', vowel: '가' },
    { forms: ['을/를', '을(를)', '(을)를', '을', '를'], batchim: '을', vowel: '를' },
    { forms: ['과/와', '과(와)', '(과)와', '과', '와'], batchim: '과', vowel: '와' },
    { forms: ['으로/로', '으로(로)', '(으)로', '으로', '로'], batchim: '으로', vowel: '로', rieul: '로' },
];

/** 이름의 마지막 한글 음절에서 종성 번호를 구한다. 한글 이름이 아니면 null. */
function getFinalJong(name) {
    const chars = [...String(name ?? '').trim()];
    for (let i = chars.length - 1; i >= 0; i--) {
        const ch = chars[i];
        const code = ch.codePointAt(0);
        if (code >= 0xAC00 && code <= 0xD7A3) return (code - 0xAC00) % 28;
        if (/\p{L}|\p{N}/u.test(ch)) return null;
    }
    return null;
}

/** {{char}}은/는 같은 표기를 현재 이름과 올바른 조사로 바꾼다. */
function resolveKoreanParticles(text) {
    const c = ctx();
    const names = { char: String(c.name2 ?? ''), user: String(c.name1 ?? '') };
    let result = String(text ?? '');

    for (const [macro, name] of Object.entries(names)) {
        if (!name.trim()) continue;
        const jong = getFinalJong(name);

        for (const rule of KOREAN_PARTICLE_RULES) {
            const forms = [...rule.forms]
                .sort((a, b) => b.length - a.length)
                .map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('|');
            const re = new RegExp(`\\{\\{${macro}\\}\\}(?:${forms})(?=$|\\s|[^\\p{L}\\p{N}_])`, 'giu');
            const particle = jong === null
                ? rule.vowel
                : (rule.rieul && jong === 8 ? rule.rieul : (jong > 0 ? rule.batchim : rule.vowel));
            result = result.replace(re, `${name}${particle}`);
        }
    }
    return result;
}

function buildText(m) {
    const text = m.content ?? '';
    let result = text;
    if (m.wrap && !/^\s*[([{<]\s*OOC\b/i.test(text)) {
        const fmt = settings().oocFormat || DEFAULTS.oocFormat;
        result = fmt.includes('{text}') ? fmt.split('{text}').join(text) : `${fmt} ${text}`;
    }
    return resolveKoreanParticles(result);
}

function markUsed(m) {
    m.useCount = (m.useCount || 0) + 1;
    m.lastUsed = Date.now();
    save();
    if (state.open) render();
}

function getList() {
    const s = settings();
    const words = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = s.memos.filter(m => {
        if (state.favOnly && !m.favorite) return false;
        if (state.tag && !(m.tags || []).includes(state.tag)) return false;
        if (!words.length) return true;
        const hay = `${m.title}\n${m.content}\n${(m.tags || []).join(' ')}`.toLowerCase();
        return words.every(w => hay.includes(w));
    });
    const cmp = {
        recent: (a, b) => (b.lastUsed || 0) - (a.lastUsed || 0),
        usage: (a, b) => (b.useCount || 0) - (a.useCount || 0),
        created: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
        title: (a, b) => displayTitle(a).localeCompare(displayTitle(b), 'ko'),
    }[s.sortBy];
    if (cmp) list.sort(cmp);
    if (s.pinFavorites) list.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
    return list;
}

/** 화면에 보이는 일부 메모만 순서를 바꾸고 나머지 위치는 유지 */
function applyOrder(ids) {
    const s = settings();
    const idSet = new Set(ids);
    const slots = [];
    s.memos.forEach((m, i) => { if (idSet.has(m.id)) slots.push(i); });
    const next = [...s.memos];
    slots.forEach((slot, k) => { next[slot] = getMemo(ids[k]); });
    s.memos = next;
    save();
    render();
}

// ───────────────────────── 입력창 / 전송 ─────────────────────────

const isGenerating = () => $('#mes_stop').is(':visible');

async function insertMemo(m, send = false) {
    const ta = document.getElementById('send_textarea');
    if (!ta) return false;
    if (send && isGenerating()) {
        toastr.warning('응답 생성 중에는 전송할 수 없어요.');
        return false;
    }

    const text = buildText(m);
    const cur = ta.value;
    let mode = settings().insertMode;
    let next = text;

    if (cur.trim()) {
        if (mode === 'ask') {
            const r = await askConfirm('입력창에 이미 글이 있어요. 어떻게 넣을까요?', '덮어쓰기', '뒤에 추가');
            if (r === null) return false;
            mode = r ? 'replace' : 'append';
        }
        if (mode === 'append') next = cur.replace(/\s+$/, '') + '\n' + text;
    }

    ta.value = next;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    markUsed(m);

    if (settings().closeAfterUse || isMobile()) closePanel();

    if (send) {
        document.getElementById('send_but')?.click();
    } else {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        toastr.info('입력창에 넣었어요.', '', { timeOut: 1500 });
    }
    return true;
}

// ───────────────────────── 복사 ─────────────────────────

/** 클립보드 밖에서는 매크로가 안 바뀌므로 복사할 때 실제 이름으로 바꾼다 */
function macrosToNames(text) {
    const c = ctx();
    if (typeof c.substituteParams === 'function') return c.substituteParams(text);
    return text
        .replace(/\{\{char\}\}/gi, c.name2 ?? '')
        .replace(/\{\{user\}\}/gi, c.name1 ?? '');
}

async function writeClipboard(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* 아래 방법으로 재시도 */ }

    // http 접속(모바일에서 PC 주소로 접속 등)에서는 clipboard API가 막혀 있음
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
}

async function copyMemo(m) {
    // 메모의 감싸기 설정과 관계없이 항상 OOC 형식으로 복사
    const text = macrosToNames(buildText({ ...m, wrap: true }));
    if (await writeClipboard(text)) {
        markUsed(m);
        toastr.success('OOC 형식으로 복사했어요.', '', { timeOut: 1500 });
    } else {
        toastr.error('복사하지 못했어요. 브라우저의 클립보드 권한을 확인하세요.');
    }
}

// ───────────────────────── 패널 UI ─────────────────────────

const PANEL_HTML = `
<div id="ooc_memo_panel" class="ooc-memo-panel">
    <div class="ooc-memo-header">
        <div class="ooc-memo-heading"><i class="fa-solid fa-note-sticky"></i> OOC 메모</div>
        <span class="ooc-memo-count"></span>
        <div class="ooc-memo-close" title="닫기"><i class="fa-solid fa-xmark"></i></div>
    </div>

    <div class="ooc-memo-toolbar">
        <div class="ooc-memo-search-wrap">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="search" class="text_pole ooc-memo-search" placeholder="제목, 내용, 태그 검색">
        </div>
        <div class="menu_button ooc-memo-fav-filter" title="즐겨찾기만 보기"><i class="fa-regular fa-star"></i></div>
        <div class="menu_button ooc-memo-add" title="새 메모"><i class="fa-solid fa-plus"></i></div>
    </div>

    <div class="ooc-memo-filterbar">
        <select class="text_pole ooc-memo-sort" title="정렬">
            <option value="manual">직접 정렬</option>
            <option value="recent">최근 사용순</option>
            <option value="usage">많이 쓴 순</option>
            <option value="created">최신 작성순</option>
            <option value="title">제목순</option>
        </select>
        <div class="ooc-memo-tags"></div>
    </div>

    <div class="ooc-memo-list"></div>

    <div class="ooc-memo-footer">
        <div class="menu_button ooc-memo-export" title="JSON으로 내보내기"><i class="fa-solid fa-file-export"></i> 내보내기</div>
        <div class="menu_button ooc-memo-import" title="JSON 가져오기"><i class="fa-solid fa-file-import"></i> 가져오기</div>
        <input type="file" accept=".json,application/json" class="ooc-memo-import-file" hidden>
    </div>

    <div class="ooc-memo-editor">
        <div class="ooc-memo-header">
            <div class="ooc-memo-heading ooc-memo-editor-heading">새 메모</div>
            <div class="ooc-memo-close ooc-memo-ed-cancel" title="취소"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <input type="text" class="text_pole ooc-memo-ed-title" placeholder="제목 (비우면 첫 줄 사용)">
        <textarea class="text_pole ooc-memo-ed-content" placeholder="내용"></textarea>
        <input type="text" class="text_pole ooc-memo-ed-tags" placeholder="태그, 쉼표로 구분 (예: 전개, 문체)">
        <label class="checkbox_label"><input type="checkbox" class="ooc-memo-ed-wrap"> OOC 형식으로 감싸기</label>
        <div class="ooc-memo-ed-preview-label">보낼 내용 미리보기</div>
        <div class="ooc-memo-ed-preview"></div>
        <div class="ooc-memo-editor-buttons">
            <div class="menu_button ooc-memo-ed-cancel">취소</div>
            <div class="menu_button ooc-memo-ed-save"><i class="fa-solid fa-check"></i> 저장</div>
        </div>
    </div>
</div>`;

let $panel;

function buildPanel() {
    $panel = $(PANEL_HTML);
    $('body').append($panel);

    $panel.on('click', '> .ooc-memo-header .ooc-memo-close', closePanel);

    $panel.on('input', '.ooc-memo-search', function () {
        state.search = this.value;
        renderList();
    });

    $panel.on('click', '.ooc-memo-fav-filter', () => {
        state.favOnly = !state.favOnly;
        render();
    });

    $panel.on('click', '.ooc-memo-add', () => openEditor());

    $panel.on('change', '.ooc-memo-sort', function () {
        settings().sortBy = this.value;
        save();
        render();
    });

    $panel.on('click', '.ooc-memo-tag', function () {
        const t = this.dataset.tag;
        state.tag = !t || state.tag === t ? null : t;
        render();
    });

    $panel.on('click', '.ooc-memo-tag-chip', function (e) {
        e.stopPropagation();
        state.tag = this.dataset.tag;
        render();
    });

    $panel.on('click', '.ooc-memo-card-body', function () {
        const id = String($(this).closest('.ooc-memo-card').data('id'));
        state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
        $(this).toggleClass('expanded');
    });

    $panel.on('click', '.ooc-memo-act', function (e) {
        e.stopPropagation();
        const id = String($(this).closest('.ooc-memo-card').data('id'));
        handleAction(this.dataset.act, id);
    });

    // 내보내기 / 가져오기
    $panel.on('click', '.ooc-memo-export', exportMemos);
    $panel.on('click', '.ooc-memo-import', () => $panel.find('.ooc-memo-import-file').trigger('click'));
    $panel.on('change', '.ooc-memo-import-file', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (file) await importMemos(file);
    });

    // 편집기
    $panel.on('input', '.ooc-memo-ed-content', updatePreview);
    $panel.on('change', '.ooc-memo-ed-wrap', updatePreview);
    $panel.on('click', '.ooc-memo-ed-cancel', closeEditor);
    $panel.on('click', '.ooc-memo-ed-save', saveEditor);
    $panel.on('keydown', '.ooc-memo-editor', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            saveEditor();
        }
    });

    $(document).on('keydown', e => {
        if (e.key !== 'Escape' || !state.open) return;
        if ($panel.find('.ooc-memo-editor').hasClass('open')) closeEditor();
        else closePanel();
    });
}

async function handleAction(act, id) {
    const s = settings();
    const m = getMemo(id);
    if (!m) return;

    switch (act) {
        case 'fav':
            m.favorite = !m.favorite;
            save();
            render();
            break;
        case 'insert':
            await insertMemo(m, false);
            break;
        case 'send':
            await insertMemo(m, true);
            break;
        case 'copy':
            await copyMemo(m);
            break;
        case 'edit':
            openEditor(m);
            break;
        case 'dup': {
            const copy = {
                ...structuredClone(m),
                id: uid(),
                title: m.title ? `${m.title} (복사)` : '',
                favorite: false,
                useCount: 0,
                lastUsed: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            s.memos.splice(s.memos.indexOf(m) + 1, 0, copy);
            save();
            render();
            break;
        }
        case 'del': {
            if (s.confirmDelete) {
                const ok = await askConfirm(`"${displayTitle(m)}" 메모를 삭제할까요?`, '삭제', '취소');
                if (!ok) return;
            }
            s.memos = s.memos.filter(x => x.id !== id);
            state.expanded.delete(id);
            save();
            render();
            break;
        }
    }
}

function openPanel() {
    state.open = true;
    hideSelBtn();
    $panel.addClass('open');
    $('body').toggleClass('ooc-memo-lock', isMobile());
    render();
    if (!isMobile()) $panel.find('.ooc-memo-search').trigger('focus');
}

function closePanel() {
    state.open = false;
    closeEditor();
    $panel.removeClass('open');
    $('body').removeClass('ooc-memo-lock');
}

const togglePanel = () => (state.open ? closePanel() : openPanel());

function render() {
    if (!$panel) return;
    const s = settings();
    $panel.find('.ooc-memo-sort').val(s.sortBy);
    $panel.find('.ooc-memo-fav-filter')
        .toggleClass('active', state.favOnly)
        .find('i').attr('class', state.favOnly ? 'fa-solid fa-star' : 'fa-regular fa-star');
    renderTags();
    renderList();
}

function renderTags() {
    const $tags = $panel.find('.ooc-memo-tags');
    const tags = [...new Set(settings().memos.flatMap(m => m.tags || []))]
        .sort((a, b) => a.localeCompare(b, 'ko'));

    if (state.tag && !tags.includes(state.tag)) state.tag = null;
    if (!tags.length) {
        $tags.empty();
        return;
    }
    const html = [`<span class="ooc-memo-tag ${!state.tag ? 'active' : ''}" data-tag="">전체</span>`]
        .concat(tags.map(t => `<span class="ooc-memo-tag ${state.tag === t ? 'active' : ''}" data-tag="${esc(t)}">#${esc(t)}</span>`));
    $tags.html(html.join(''));
}

function cardHtml(m, draggable) {
    const tags = (m.tags || [])
        .map(t => `<span class="ooc-memo-tag-chip" data-tag="${esc(t)}">#${esc(t)}</span>`)
        .join('');

    return `
    <div class="ooc-memo-card ${m.favorite ? 'is-fav' : ''}" data-id="${esc(m.id)}">
        <div class="ooc-memo-card-head">
            ${draggable ? '<i class="fa-solid fa-grip-vertical ooc-memo-handle" title="끌어서 순서 변경"></i>' : ''}
            <div class="ooc-memo-card-title">${esc(displayTitle(m))}</div>
            <i class="${m.favorite ? 'fa-solid' : 'fa-regular'} fa-star ooc-memo-act ooc-memo-star" data-act="fav" title="즐겨찾기"></i>
        </div>
        <div class="ooc-memo-card-body ${state.expanded.has(m.id) ? 'expanded' : ''}" title="눌러서 펼치기/접기">${esc(m.content)}</div>
        <div class="ooc-memo-card-meta">
            ${tags}
            <span class="ooc-memo-usage" title="사용 횟수">${m.useCount || 0}회 사용</span>
        </div>
        <div class="ooc-memo-card-actions">
            <div class="menu_button ooc-memo-act" data-act="insert" title="입력창에 넣기"><i class="fa-solid fa-paste"></i><span>넣기</span></div>
            <div class="menu_button ooc-memo-act" data-act="send" title="넣고 바로 전송"><i class="fa-solid fa-paper-plane"></i><span>전송</span></div>
            <div class="menu_button ooc-memo-act" data-act="copy" title="OOC 형식으로 복사"><i class="fa-solid fa-copy"></i><span>복사</span></div>
            <div class="ooc-memo-spacer"></div>
            <div class="menu_button ooc-memo-act ooc-memo-icon-btn" data-act="edit" title="수정"><i class="fa-solid fa-pen"></i></div>
            <div class="menu_button ooc-memo-act ooc-memo-icon-btn" data-act="dup" title="복제"><i class="fa-solid fa-clone"></i></div>
            <div class="menu_button ooc-memo-act ooc-memo-icon-btn" data-act="del" title="삭제"><i class="fa-solid fa-trash"></i></div>
        </div>
    </div>`;
}

function renderList() {
    const s = settings();
    const list = getList();
    const $list = $panel.find('.ooc-memo-list');
    const draggable = s.sortBy === 'manual';

    if (!list.length) {
        const msg = s.memos.length
            ? '조건에 맞는 메모가 없어요. 검색어나 필터를 바꿔 보세요.'
            : '아직 메모가 없어요. + 버튼으로 첫 메모를 추가하세요.';
        $list.html(`<div class="ooc-memo-empty">${msg}</div>`);
    } else {
        $list.html(list.map(m => cardHtml(m, draggable)).join(''));
        if (draggable) $list[0].querySelectorAll('.ooc-memo-handle').forEach(h => h.addEventListener('pointerdown', onDragStart));
    }

    const total = s.memos.length;
    $panel.find('.ooc-memo-count').text(list.length === total ? `${total}개` : `${list.length} / ${total}개`);
}

// ───────────────────────── 드래그 정렬 (마우스·터치 공용) ─────────────────────────

function onDragStart(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const card = handle.closest('.ooc-memo-card');
    const list = card.parentElement;
    const ac = new AbortController();
    card.classList.add('dragging');
    handle.setPointerCapture?.(e.pointerId);

    const move = ev => {
        const y = ev.clientY;
        const others = [...list.querySelectorAll('.ooc-memo-card:not(.dragging)')];
        const after = others.find(el => {
            const r = el.getBoundingClientRect();
            return y < r.top + r.height / 2;
        });
        if (after) {
            if (card.nextElementSibling !== after) list.insertBefore(card, after);
        } else if (list.lastElementChild !== card) {
            list.appendChild(card);
        }
        const lr = list.getBoundingClientRect();
        if (y < lr.top + 40) list.scrollTop -= 12;
        else if (y > lr.bottom - 40) list.scrollTop += 12;
    };

    const end = () => {
        ac.abort();
        card.classList.remove('dragging');
        const ids = [...list.querySelectorAll('.ooc-memo-card')].map(el => el.dataset.id);
        applyOrder(ids);
    };

    handle.addEventListener('pointermove', move, { signal: ac.signal });
    handle.addEventListener('pointerup', end, { signal: ac.signal });
    handle.addEventListener('pointercancel', end, { signal: ac.signal });
}

// ───────────────────────── 편집기 ─────────────────────────

function openEditor(memo = null, prefill = '') {
    const $ed = $panel.find('.ooc-memo-editor');
    state.editingId = memo?.id ?? null;

    $ed.find('.ooc-memo-editor-heading').text(memo ? '메모 수정' : '새 메모');
    $ed.find('.ooc-memo-ed-title').val(memo?.title ?? '');
    $ed.find('.ooc-memo-ed-content').val(memo?.content ?? prefill);
    $ed.find('.ooc-memo-ed-tags').val((memo?.tags ?? (state.tag ? [state.tag] : [])).join(', '));
    $ed.find('.ooc-memo-ed-wrap').prop('checked', memo ? !!memo.wrap : settings().defaultWrap);

    $ed.addClass('open');
    updatePreview();
    if (!isMobile()) setTimeout(() => $ed.find('.ooc-memo-ed-content').trigger('focus'), 0);
}

function closeEditor() {
    $panel?.find('.ooc-memo-editor').removeClass('open');
    state.editingId = null;
}

function updatePreview() {
    const $ed = $panel.find('.ooc-memo-editor');
    const text = buildText({
        content: $ed.find('.ooc-memo-ed-content').val(),
        wrap: $ed.find('.ooc-memo-ed-wrap').prop('checked'),
    });
    $ed.find('.ooc-memo-ed-preview').text(text || ' ');
}

function saveEditor() {
    const s = settings();
    const $ed = $panel.find('.ooc-memo-editor');
    const content = String($ed.find('.ooc-memo-ed-content').val());
    if (!content.trim()) {
        toastr.warning('내용을 입력하세요.');
        return;
    }

    const data = {
        title: String($ed.find('.ooc-memo-ed-title').val()).trim(),
        content,
        tags: parseTags($ed.find('.ooc-memo-ed-tags').val()),
        wrap: $ed.find('.ooc-memo-ed-wrap').prop('checked'),
        updatedAt: Date.now(),
    };

    const existing = state.editingId && getMemo(state.editingId);
    if (existing) {
        Object.assign(existing, data);
    } else {
        s.memos.unshift(normalizeMemo({ ...data, id: uid(), createdAt: Date.now() }));
    }
    save();
    closeEditor();
    render();
    toastr.success('저장했어요.', '', { timeOut: 1500 });
}

// ───────────────────────── 내보내기 / 가져오기 ─────────────────────────

function exportMemos() {
    const memos = settings().memos;
    if (!memos.length) {
        toastr.info('내보낼 메모가 없어요.');
        return;
    }
    const data = { type: 'ooc-memo', version: 2, exportedAt: new Date().toISOString(), memos };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ooc-memo-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toastr.success(`${memos.length}개 메모를 내보냈어요.`);
}

async function importMemos(file) {
    let parsed;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        toastr.error('JSON 파일을 읽을 수 없어요. 파일 형식을 확인하세요.');
        return;
    }
    const raw = Array.isArray(parsed) ? parsed : parsed?.memos;
    if (!Array.isArray(raw)) {
        toastr.error('메모 목록을 찾지 못했어요. OOC 메모에서 내보낸 파일인지 확인하세요.');
        return;
    }

    const s = settings();
    const ids = new Set(s.memos.map(m => m.id));
    const sig = m => `${m.title}\u0000${m.content}`;
    const sigs = new Set(s.memos.map(sig));
    let added = 0;
    let skipped = 0;

    for (const r of raw) {
        const m = normalizeMemo(r);
        if (!m || sigs.has(sig(m))) { skipped++; continue; }
        if (ids.has(m.id)) m.id = uid();
        s.memos.push(m);
        ids.add(m.id);
        sigs.add(sig(m));
        added++;
    }
    save();
    render();
    toastr.success(`${added}개 추가${skipped ? `, 중복 ${skipped}개 건너뜀` : ''}`);
}

// ───────────────────────── 채팅 메시지에서 저장 ─────────────────────────
// 1) 메시지 ⋯ 메뉴의 📝 버튼 → 메시지 전체 저장
// 2) 채팅 글자를 선택하면 뜨는 "메모로 저장" 버튼 → 선택한 부분만 저장

const MES_BTN_HTML = '<div class="mes_button ooc-memo-mes-btn fa-solid fa-note-sticky interactable" title="OOC 메모로 저장" tabindex="0"></div>';

function injectMesButton($mes) {
    if ($mes.find('.ooc-memo-mes-btn').length) return;
    const $extra = $mes.find('.extraMesButtons').first();
    if ($extra.length) {
        $extra.prepend(MES_BTN_HTML);
        return;
    }
    // 버전에 따라 ⋯ 메뉴가 없으면 버튼 줄에 직접 추가
    const $btns = $mes.find('.mes_buttons').first();
    if ($btns.length) $btns.prepend(MES_BTN_HTML);
}

function addMesButtons() {
    const on = settings().showMesButton;
    const $tpl = $('#message_template');

    if (!on) {
        $('.ooc-memo-mes-btn').remove();
        return;
    }
    // 템플릿에 넣어두면 앞으로 그려지는 모든 메시지에 자동으로 포함됨
    if ($tpl.length) injectMesButton($tpl);
    $('#chat .mes').each(function () { injectMesButton($(this)); });
}

const escapeRe = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 채팅 속 캐릭터/유저 이름을 {{char}} / {{user}} 매크로로 바꾼다 */
function namesToMacros(text, mes) {
    const c = ctx();
    // 그룹 채팅이면 그 메시지를 쓴 캐릭터 이름을 {{char}}로
    const charName = (mes && !mes.is_user && mes.name) ? mes.name : c.name2;
    const userName = (mes && mes.is_user && mes.name) ? mes.name : c.name1;

    const map = new Map();
    if (userName?.trim()) map.set(userName.trim(), '{{user}}');
    if (charName?.trim()) map.set(charName.trim(), '{{char}}'); // 이름이 같으면 캐릭터 우선
    if (!map.size) return text;

    // 긴 이름부터 찾아서 "김민수"가 "민수"로 먼저 잘리지 않게 함
    const names = [...map.keys()].sort((a, b) => b.length - a.length);
    const re = new RegExp(names.map(escapeRe).join('|'), 'g');
    return text.replace(re, m => map.get(m) ?? m);
}

function saveFromChat(text, mesId = null) {
    text = String(text ?? '').trim();
    if (text && settings().macroOnSave) {
        const mes = Number.isInteger(mesId) ? ctx().chat?.[mesId] : null;
        text = namesToMacros(text, mes);
    }
    if (!text) {
        toastr.warning('저장할 내용이 없어요.');
        return;
    }
    if (!state.open) openPanel();
    openEditor(null, text);
}

// 선택 영역 저장 버튼
let $selBtn = null;

function hideSelBtn() {
    $selBtn?.removeClass('show');
    state.savedSelection = '';
    state.savedSelectionMesId = null;
}

function selectedChatText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const node = sel.anchorNode;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el?.closest('#chat .mes_text')) return null;
    const mesId = Number(el.closest('.mes')?.getAttribute('mesid'));
    return { text, mesId: Number.isInteger(mesId) ? mesId : null, rect: sel.getRangeAt(0).getBoundingClientRect() };
}

function updateSelBtn() {
    if (!settings().showSelButton || state.open) return hideSelBtn();
    const info = selectedChatText();
    if (!info) return hideSelBtn();

    state.savedSelection = info.text;
    state.savedSelectionMesId = info.mesId;
    $selBtn.addClass('show');

    const w = $selBtn.outerWidth();
    const h = $selBtn.outerHeight();
    const r = info.rect;
    const gap = isMobile() ? 36 : 8; // 모바일은 선택 손잡이를 피해서 조금 더 아래로
    let top = r.bottom + gap;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - gap);
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    $selBtn.css({ top: `${top}px`, left: `${left}px` });
}

function buildSelectionButton() {
    $selBtn = $('<div id="ooc_memo_selection_float" class="ooc-memo-sel-btn"><i class="fa-solid fa-note-sticky"></i><span>메모로 저장</span></div>');
    $('body').append($selBtn);
    const el = $selBtn[0];

    // 누르는 순간 선택이 풀리지 않도록 기본 동작 차단
    const keep = e => { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener('pointerdown', keep);
    el.addEventListener('mousedown', keep);
    el.addEventListener('touchstart', keep, { passive: false });

    const activate = e => {
        keep(e);
        const text = state.savedSelection;
        const mesId = state.savedSelectionMesId;
        if (!text) return; // touchend 후 click이 한 번 더 들어오는 경우 무시
        hideSelBtn();
        window.getSelection()?.removeAllRanges();
        saveFromChat(text, mesId);
    };
    el.addEventListener('click', activate);
    el.addEventListener('touchend', activate, { passive: false });

    document.addEventListener('selectionchange', debounce(updateSelBtn, 250));
    document.getElementById('chat')?.addEventListener('scroll', hideSelBtn, { passive: true });
    window.addEventListener('resize', hideSelBtn);
}

function bindMesButtons() {
    // 캡처 단계에서 받아야 실리태번이 이벤트를 막아도 동작함
    document.addEventListener('click', e => {
        const btn = e.target.closest?.('.ooc-memo-mes-btn');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const $mes = $(btn).closest('.mes');
        const mesId = Number($mes.attr('mesid'));
        const text = ctx().chat?.[mesId]?.mes ?? $mes.find('.mes_text').text();
        saveFromChat(text, Number.isInteger(mesId) ? mesId : null);
    }, true);

    const chat = document.getElementById('chat');
    if (chat) new MutationObserver(debounce(addMesButtons, 150)).observe(chat, { childList: true, subtree: true });
}

// ───────────────────────── 슬래시 커맨드 ─────────────────────────

function findMemo(q) {
    const list = settings().memos;
    const lq = q.toLowerCase();
    const t = m => displayTitle(m).toLowerCase();
    return list.find(m => t(m) === lq)
        || list.find(m => t(m).startsWith(lq))
        || list.find(m => t(m).includes(lq))
        || list.find(m => (m.content || '').toLowerCase().includes(lq));
}

function memoEnumProvider() {
    return settings().memos.map(m => {
        const description = String(m.content || '').replace(/\s+/g, ' ').trim();
        const preview = description.length > 80 ? `${description.slice(0, 80)}…` : description;
        return new SlashCommandEnumValue(displayTitle(m), preview, enumTypes.name, '📝');
    });
}

function registerSlash() {
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx();
        if (!SlashCommandParser || !SlashCommand) return;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'ooc',
            callback: async (args, value) => {
                const q = String(value ?? '').trim();
                if (!q) {
                    openPanel();
                    return '';
                }
                const m = findMemo(q);
                if (!m) {
                    toastr.warning(`"${q}" 메모를 찾지 못했어요.`);
                    return '';
                }
                const mode = String(args?.mode ?? 'insert').toLowerCase();
                if (mode === 'text') {
                    markUsed(m);
                    return buildText(m);
                }
                // 커맨드 실행 후 입력창이 비워지는 것을 기다린 뒤 넣기
                setTimeout(() => insertMemo(m, mode === 'send'), 150);
                return '';
            },
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'mode',
                    description: 'insert: 입력창에 넣기 / send: 바로 전송 / text: 텍스트만 반환',
                    typeList: [ARGUMENT_TYPE.STRING],
                    defaultValue: 'insert',
                    enumList: ['insert', 'send', 'text'],
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: '메모 제목 (일부만 써도 됨). 비우면 패널을 엽니다.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                    enumProvider: memoEnumProvider,
                }),
            ],
            helpString: `
                <div>OOC 메모를 제목으로 불러옵니다.</div>
                <ul>
                    <li><code>/ooc 전개</code> — 입력창에 넣기</li>
                    <li><code>/ooc mode=send 전개</code> — 바로 전송</li>
                    <li><code>/ooc mode=text 전개 | /echo</code> — 텍스트만 반환</li>
                    <li><code>/ooc</code> — 패널 열기</li>
                </ul>`,
        }));
    } catch (err) {
        console.warn('[OOC Memo] 슬래시 커맨드 등록 실패:', err);
    }
}

// ───────────────────────── 설정 탭 / 메뉴 버튼 ─────────────────────────

const SETTINGS_HTML = `
<div class="ooc-memo-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>📝 OOC 메모</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="ooc-memo-set-row">
                <label class="checkbox_label"><input type="checkbox" id="ooc_memo_default_wrap"> 새 메모는 OOC 형식으로 감싸기</label>
            </div>

            <div class="ooc-memo-set-field">
                <label for="ooc_memo_format">OOC 형식</label>
                <input type="text" id="ooc_memo_format" class="text_pole" placeholder="(OOC: {text})">
                <small>{text} 자리에 메모 내용이 들어갑니다.</small>
            </div>

            <div class="ooc-memo-set-field">
                <label for="ooc_memo_insert_mode">입력창에 글이 있을 때</label>
                <select id="ooc_memo_insert_mode" class="text_pole">
                    <option value="ask">매번 묻기</option>
                    <option value="replace">덮어쓰기</option>
                    <option value="append">뒤에 추가</option>
                </select>
            </div>

            <div class="ooc-memo-set-row">
                <label class="checkbox_label"><input type="checkbox" id="ooc_memo_pin_fav"> 즐겨찾기를 목록 위에 고정</label>
                <label class="checkbox_label"><input type="checkbox" id="ooc_memo_confirm_del"> 삭제 전에 확인</label>
                <label class="checkbox_label"><input type="checkbox" id="ooc_memo_mes_btn"> 메시지 ⋯ 메뉴에 저장 버튼(📝) 표시</label>
                <label class="checkbox_label"><input type="checkbox" id="ooc_memo_sel_btn"> 채팅 글자를 선택하면 "메모로 저장" 버튼 표시</label>
                <label class="checkbox_label"><input type="checkbox" id="ooc_memo_macro_save"> 채팅에서 저장할 때 캐릭터/유저 이름을 {{char}} / {{user}}로 바꾸기</label>
                <label class="checkbox_label"><input type="checkbox" id="ooc_memo_close_after"> 넣기/전송 후 패널 닫기 (모바일은 항상)</label>
            </div>

            <div id="ooc_memo_open_btn" class="menu_button ooc-memo-open-btn">
                <i class="fa-solid fa-note-sticky"></i><span>메모장 열기</span>
            </div>
        </div>
    </div>
</div>`;

function buildSettings() {
    const s = settings();
    const $root = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    $root.append(SETTINGS_HTML);

    $('#ooc_memo_default_wrap').prop('checked', s.defaultWrap).on('change', function () { s.defaultWrap = this.checked; save(); });
    $('#ooc_memo_format').val(s.oocFormat).on('input', function () { s.oocFormat = this.value; save(); });
    $('#ooc_memo_insert_mode').val(s.insertMode).on('change', function () { s.insertMode = this.value; save(); });
    $('#ooc_memo_pin_fav').prop('checked', s.pinFavorites).on('change', function () { s.pinFavorites = this.checked; save(); render(); });
    $('#ooc_memo_confirm_del').prop('checked', s.confirmDelete).on('change', function () { s.confirmDelete = this.checked; save(); });
    $('#ooc_memo_mes_btn').prop('checked', s.showMesButton).on('change', function () { s.showMesButton = this.checked; save(); addMesButtons(); });
    $('#ooc_memo_sel_btn').prop('checked', s.showSelButton).on('change', function () { s.showSelButton = this.checked; save(); if (!this.checked) hideSelBtn(); });
    $('#ooc_memo_macro_save').prop('checked', s.macroOnSave).on('change', function () { s.macroOnSave = this.checked; save(); });
    $('#ooc_memo_close_after').prop('checked', s.closeAfterUse).on('change', function () { s.closeAfterUse = this.checked; save(); });
    $('#ooc_memo_open_btn').on('click', openPanel);
}

function addWandButton() {
    const $menu = $('#extensionsMenu');
    if (!$menu.length) return;
    $menu.append(`
        <div id="ooc_memo_wand" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid fa-note-sticky extensionsMenuExtensionButton"></div>
            OOC 메모
        </div>`);
    $('#ooc_memo_wand').on('click', togglePanel);
}

// ───────────────────────── 시작 ─────────────────────────

jQuery(() => {
    const s = settings();
    save(); // 마이그레이션 결과 저장
    buildPanel();
    buildSettings();
    addWandButton();
    bindMesButtons();
    buildSelectionButton();
    registerSlash();

    const c = ctx();
    const et = c.eventTypes ?? c.event_types;
    c.eventSource.on(et.CHAT_CHANGED, addMesButtons);
    addMesButtons();
    console.log(`[OOC Memo] 메시지 버튼: ${$('#chat .ooc-memo-mes-btn').length}개, 템플릿: ${$('#message_template .ooc-memo-mes-btn').length ? '적용됨' : '없음'}`);

    window.addEventListener('resize', debounce(() => {
        if (state.open) $('body').toggleClass('ooc-memo-lock', isMobile());
    }, 150));

    console.log(`[OOC Memo] loaded (${s.memos.length} memos)`);
});
