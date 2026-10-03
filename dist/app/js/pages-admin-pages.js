// The admin Pages section: edit and preview an instance's own published pages.
//
// Pages are documents, not a stack of draggable content blocks. The editor stores
// one continuous BBCode document and sends it through the existing page API as the
// single paragraph content format the server already understands.

import Api from './api.js';
import { el, clear, toast, openModal, confirmDialog } from './ui.js';
import { emptyState } from './components.js';
import { renderContextHeader } from './shell.js';
import { settingsFrame } from './settings-shell.js';
import { sectionHead } from './settings-ui.js';
import { navigate } from './nav.js';

function statusChipFor(page) {
  if (page.status === 'PUBLISHED') return ['Published', 'resolved'];
  if (page.status === 'DRAFT') return ['Draft', 'open'];
  return ['Not edited', 'dismissed'];
}

function pageList() {
  const wrap = el('div', { class: 'card-list' });
  Api.adminPages().then((pages) => {
    if (!pages.length) {
      wrap.appendChild(emptyState('', 'No editable pages.', 'This instance exposes no static pages.'));
      return;
    }

    for (const p of pages) {
      const row = el('div', { class: 'card card--list--row' });
      const [label, cls] = statusChipFor(p);
      row.appendChild(el('span', { class: 'status-chip ' + cls }, label));
      if (p.legal) row.appendChild(el('span', { class: 'status-chip warning' }, 'legal'));

      const info = el('div', { class: 'grow' });
      info.appendChild(el('div', { class: 'admin-name' }, '/' + p.route));
      info.appendChild(el('div', { class: 'muted small' }, p.title));

      const lines = [];
      if (p.publishedAt) lines.push('published ' + new Date(p.publishedAt).toLocaleString());
      if (p.draftAt && p.status !== 'PUBLISHED') {
        lines.push('draft saved ' + new Date(p.draftAt).toLocaleString());
      }
      if (p.outstandingFields && p.outstandingFields.length) {
        lines.push(p.outstandingFields.length + ' operator field(s) still unfilled');
      }
      if (lines.length) info.appendChild(el('div', { class: 'muted small' }, lines.join(' · ')));
      row.appendChild(info);

      const acts = el('div', { class: 'card--list__actions' });
      acts.appendChild(el('button', {
        class: 'btn sm',
        type: 'button',
        onClick: () => navigate('/admin/pages/' + p.route),
      }, 'Edit'));
      acts.appendChild(el('button', {
        class: 'btn ghost sm',
        type: 'button',
        onClick: () => window.open('/' + p.route, '_blank', 'noopener'),
      }, 'View'));
      row.appendChild(acts);
      wrap.appendChild(row);
    }
  }).catch((ex) => {
    wrap.appendChild(el('p', { class: 'form-error' }, ex.message || 'Could not load pages.'));
  });

  return wrap;
}

const BBCODE_TOOLS = [
  { tag: 'b', label: 'B', title: 'Bold' },
  { tag: 'i', label: 'I', title: 'Italic' },
  { tag: 'u', label: 'U', title: 'Underline' },
  { tag: 's', label: 'S', title: 'Strikethrough' },
  { tag: 'url', label: 'Link', title: 'Link', arg: 'https://', body: 'link text' },
  { tag: 'quote', label: 'Quote', title: 'Quotation' },
  { tag: 'code', label: 'Code', title: 'Preformatted, contents shown literally' },
  { tag: 'spoiler', label: 'Spoiler', title: 'Hidden until focused' },
  { tag: 'color', label: 'Colour', title: 'Named colour or #hex', arg: 'red' },
  { tag: 'size', label: 'Size', title: '1 (small) to 7 (large)', arg: '5' },
  { tag: 'center', label: 'Centre', title: 'Centred' },
];

function applyBBCode(input, spec) {
  const start = input.selectionStart == null ? input.value.length : input.selectionStart;
  const end = input.selectionEnd == null ? start : input.selectionEnd;
  const sel = input.value.slice(start, end);

  const open = spec.arg
    ? '[' + spec.tag + '=' + spec.arg + ']'
    : '[' + spec.tag + ']';
  const close = '[/' + spec.tag + ']';
  const body = sel || spec.body || '';

  input.value = input.value.slice(0, start) + open + body + close + input.value.slice(end);

  const caret = sel ? start + open.length + sel.length : start + open.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function bbcodeBar(input) {
  const bar = el('div', {
    class: 'bbcode-bar',
    role: 'toolbar',
    'aria-label': 'Formatting',
  });

  for (const spec of BBCODE_TOOLS) {
    bar.appendChild(el('button', {
      class: 'bbcode-bar__btn',
      type: 'button',
      title: spec.title,
      'aria-label': spec.title,
      onClick: (event) => {
        event.preventDefault();
        applyBBCode(input, spec);
      },
    }, spec.label));
  }

  return bar;
}

function pageProse(html) {
  const node = el('div', { class: 'prose', html });
  for (const a of node.querySelectorAll('a[href]')) {
    if (!(a.getAttribute('href') || '').startsWith('#')) {
      a.setAttribute('data-document', '');
    }
  }
  return node;
}

/*
 * The current API still accepts the page body as an array of blocks. Keep that
 * transport contract here instead of creating a second backend format: the
 * editor itself is one continuous document, represented by one paragraph block.
 *
 * Existing drafts can still contain the older block vocabulary. Flatten them
 * when loading so opening the new editor does not silently throw their content
 * away.
 */
function blocksToDocument(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return '';

  return blocks.map((block) => {
    if (!block) return '';

    switch (block.type) {
      case 'heading':
        return '[b]' + (block.text || '') + '[/b]';

      case 'paragraph':
      case 'lead':
      case 'note':
        return block.text || '';

      case 'list':
        return (block.items || []).map((item, index) =>
          (block.ordered ? (index + 1) + '. ' : '• ') + item
        ).join('\n');

      case 'link':
        return '[url=' + (block.href || '') + ']' +
          (block.text || block.href || '') +
          '[/url]';

      case 'rule':
        return '────────────────────────────────';

      default:
        return block.text || '';
    }
  }).filter((part) => part !== '').join('\n\n');
}

function documentToBlocks(content) {
  return content ? [{ type: 'paragraph', text: content }] : [];
}

function pageEditor(container, route) {
  clear(container);
  document.documentElement.dataset.fullpage = 'page-editor';

  const wrap = el('div', { class: 'page-editor' });

  const head = el('header', { class: 'page-editor__bar' });

  head.appendChild(el('button', {
    class: 'btn ghost sm',
    type: 'button',
    onClick: () => navigate('/admin/pages'),
  }, '← All pages'));

  head.appendChild(el('h1', {
    class: 'page-editor__title',
  }, '/' + route));

  wrap.appendChild(head);

  const main = el('div', { class: 'page-editor__main' });
  const body = el('div', { class: 'page-editor__body' });
  const side = el('aside', { class: 'page-editor__side' });

  main.appendChild(body);
  main.appendChild(side);
  wrap.appendChild(main);
  container.appendChild(wrap);

  const state = {
    content: '',
    title: '',
    page: null,
    dirty: false,
  };

  const paintStatus = () => {
    const status = body.querySelector('[data-dirty]');
    if (status) {
      status.textContent = state.dirty ? 'Unsaved changes' : 'Saved';
    }
  };

  let editorInput = null;
  let previewTimer = null;
  let previewSeq = 0;

  const queuePreview = () => {
    if (previewTimer) clearTimeout(previewTimer);

    previewTimer = setTimeout(() => {
      previewTimer = null;
      const mine = ++previewSeq;

      Api.adminPreviewPage(route, documentToBlocks(state.content))
        .then((result) => {
          if (mine !== previewSeq) return;

          clear(previewOut);
          previewOut.appendChild(pageProse(result.html));
        })
        .catch(() => {
          if (mine !== previewSeq) return;

          clear(previewOut);
          previewOut.appendChild(el('p', {
            class: 'muted small',
          }, 'Preview unavailable.'));
        });
    }, 400);
  };

  const markDirty = () => {
    state.dirty = true;
    paintStatus();
    queuePreview();
  };

  const previewOut = el('div', {
    class: 'page-editor__preview prose',
  });

  side.appendChild(el(
    'div',
    { class: 'page-editor__side-inner' },

    el('div', {
      class: 'section-label',
    }, 'Preview'),

    previewOut,

    el('div', {
      class: 'section-label',
    }, 'Formatting'),

    el('p', {
      class: 'muted small',
    },
      'Write the entire page as one document. The toolbar inserts BBCode into the text at the current selection.'
    ),

    el(
      'ul',
      { class: 'bbcode-ref' },
      ...BBCODE_TOOLS.map((tool) =>
        el(
          'li',
          {},
          el(
            'code',
            {},
            '[' +
              tool.tag +
              (tool.arg ? '=' + tool.arg : '') +
              ']' +
              (tool.body || '…') +
              '[/' +
              tool.tag +
              ']'
          ),
          el(
            'span',
            { class: 'muted small' },
            ' ' + tool.title
          )
        )
      )
    )
  ));

  const rebuild = () => {
    clear(body);

    body.appendChild(el(
      'div',
      { class: 'page-editor__status' },
      el(
        'span',
        {
          class: 'muted small',
          'data-dirty': '',
        },
        state.dirty ? 'Unsaved changes' : 'Saved'
      )
    ));

    const title = el('input', {
      class: 'input',
      id: 'page-title',
      type: 'text',
      value: state.title,
    });

    title.addEventListener('input', () => {
      state.title = title.value;
      markDirty();
    });

    body.appendChild(el(
      'div',
      { class: 'field' },
      el('label', { for: 'page-title' }, 'Page title'),
      title
    ));

    if (state.page.legal) {
      body.appendChild(el(
        'div',
        {
          class: 'draft-note',
          role: 'note',
        },
        el('strong', {}, 'This is a legal page. '),
        'Publishing is visible to everyone immediately and is written to the audit log. Check the content carefully before you publish.'
      ));
    }

    if (!state.content && state.page.status !== 'PUBLISHED') {
      const box = el('div', {
        class: 'draft-note',
        role: 'note',
      });

      box.appendChild(el(
        'strong',
        {},
        'Nothing drafted yet. '
      ));

      box.appendChild(el(
        'span',
        {},
        'Visitors are currently seeing the template that ships with Trycord. ' +
        'Write the document below, or save an empty draft to publish a blank page.'
      ));

      body.appendChild(box);
    }

    if (state.page.outstandingFields && state.page.outstandingFields.length) {
      const box = el('div', { class: 'field' });

      box.appendChild(el(
        'strong',
        {},
        'Still to fill in'
      ));

      const ul = el('ul', {});

      for (const field of state.page.outstandingFields) {
        ul.appendChild(el(
          'li',
          { class: 'muted small' },
          field
        ));
      }

      box.appendChild(ul);
      body.appendChild(box);
    }

    const editor = el('div', {
      class: 'field page-editor__document',
    });

    editor.appendChild(el(
      'label',
      { for: 'page-document' },
      'Page content'
    ));

    editorInput = el('textarea', {
      class: 'textarea page-editor__textarea',
      id: 'page-document',
      rows: 30,
      spellcheck: 'true',
      'aria-label': 'Page content',
    });

    editorInput.value = state.content;

    editorInput.addEventListener('input', () => {
      state.content = editorInput.value;
      markDirty();
    });

    editor.appendChild(bbcodeBar(editorInput));

    editor.appendChild(editorInput);

    editor.appendChild(el(
      'span',
      { class: 'hint' },
      'Write the whole page here. BBCode is stored as text and rendered by the existing page renderer.'
    ));

    body.appendChild(editor);

    const actions = el('div', {
      class: 'page-editor__actions',
    });

    actions.appendChild(el('button', {
      class: 'btn',
      type: 'button',
      onClick: () =>
        Api.adminPreviewPage(
          route,
          documentToBlocks(state.content)
        )
          .then((result) =>
            openModal({
              title: 'Preview',
              body: pageProse(result.html),
            })
          )
          .catch((ex) =>
            toast(
              ex.message || 'Preview failed',
              'error'
            )
          ),
    }, 'Preview'));

    actions.appendChild(el('button', {
      class: 'btn primary',
      type: 'button',
      onClick: async () => {
        try {
          const saved = await Api.adminSavePageDraft(
            route,
            state.title,
            documentToBlocks(state.content)
          );

          state.page = saved;
          state.content = blocksToDocument(
            saved.draft || documentToBlocks(state.content)
          );
          state.dirty = false;

          toast('Draft saved.', 'ok');
          paintStatus();
          queuePreview();
        } catch (ex) {
          toast(
            ex.message || 'Could not save',
            'error'
          );
        }
      },
    }, 'Save draft'));

    if (state.page.status === 'PUBLISHED') {
      actions.appendChild(el('button', {
        class: 'btn',
        type: 'button',
        onClick: () =>
          confirmDialog({
            title: 'Unpublish this page?',
            message: 'Visitors will see the file on disk again until you publish a new draft.',
            danger: true,
            confirmText: 'Unpublish',

            onConfirm: async () => {
              try {
                state.page = await Api.adminUnpublishPage(route);

                toast('Unpublished.', 'ok');
                rebuild();
              } catch (ex) {
                toast(
                  ex.message || 'Could not unpublish',
                  'error'
                );
              }
            },
          }),
      }, 'Unpublish'));

      actions.appendChild(el('button', {
        class: 'btn primary',
        type: 'button',
        onClick: () => publishFlow(state),
      }, 'Publish changes'));
    } else {
      actions.appendChild(el('button', {
        class: 'btn primary',
        type: 'button',
        onClick: () => publishFlow(state),
      }, 'Publish'));
    }

    actions.appendChild(el('button', {
      class: 'btn ghost',
      type: 'button',
      onClick: () => showRevisions(state, route),
    }, 'Revision history'));

    wrap.appendChild(actions);

    if (state.page.publishedAt) {
      body.appendChild(el(
        'p',
        { class: 'muted small' },
        'Last published ' +
          new Date(state.page.publishedAt).toLocaleString() +
          '.'
      ));
    }

    paintStatus();
    queuePreview();
  };

  const publishFlow = async (st) => {
    if (st.dirty) {
      try {
        st.page = await Api.adminSavePageDraft(
          route,
          st.title,
          documentToBlocks(st.content)
        );

        st.content = blocksToDocument(
          st.page.draft || documentToBlocks(st.content)
        );

        st.dirty = false;
      } catch (ex) {
        toast(
          ex.message || 'Save the draft first',
          'error'
        );
        return;
      }
    }

    const err = el('div', {
      class: 'form-error',
      hidden: true,
    });

    const confirm = el('input', {
      class: 'input',
      id: 'publish-confirm',
      type: 'text',
      placeholder: route,
    });

    const modal = openModal({
      title: st.page.legal
        ? 'Publish a legal page?'
        : 'Publish this page?',

      body: el(
        'div',
        { class: 'admin-form' },

        err,

        st.page.legal
          ? el(
              'div',
              {
                class: 'draft-note',
                role: 'note',
              },
              el(
                'strong',
                {},
                'This page may contain legal or privacy terms. Verify the content before publishing.'
              )
            )
          : null,

        el(
          'p',
          { class: 'muted small' },
          'Visitors see the change immediately.'
        ),

        el(
          'div',
          { class: 'field' },
          el(
            'label',
            { for: 'publish-confirm' },
            'Type /' + route + ' to confirm'
          ),
          confirm
        )
      ),

      footer: [
        el(
          'button',
          {
            class: 'btn ghost',
            type: 'button',
            onClick: () => modal.close(),
          },
          'Cancel'
        ),

        el(
          'button',
          {
            class: 'btn primary',
            type: 'button',

            onClick: async () => {
              err.hidden = true;

              try {
                st.page = await Api.adminPublishPage(
                  route,
                  confirm.value
                );

                modal.close();
                toast('Published.', 'ok');
                rebuild();
              } catch (ex) {
                err.hidden = false;
                err.textContent =
                  ex.message || 'Could not publish';
              }
            },
          },
          'Publish'
        ),
      ],
    });

    confirm.focus();
  };

  const showRevisions = async (st) => {
    let list = [];

    try {
      list = await Api.adminPageRevisions(route);
    } catch (ex) {
      toast(
        ex.message || 'Could not load history',
        'error'
      );
      return;
    }

    const box = el('div', {
      class: 'card-list',
    });

    if (!list.length) {
      box.appendChild(
        emptyState(
          '',
          'No revisions yet.',
          'Save a draft to start the history.'
        )
      );
    }

    for (const rev of list) {
      const row = el('div', {
        class: 'card card--list--row',
      });

      row.appendChild(el(
        'span',
        {
          class:
            'status-chip ' +
            (rev.state === 'PUBLISHED'
              ? 'resolved'
              : 'open'),
        },
        '#' + rev.revision
      ));

      const info = el('div', {
        class: 'grow',
      });

      info.appendChild(el(
        'div',
        { class: 'muted small' },
        rev.state.toLowerCase() +
          ' · ' +
          new Date(rev.created_at).toLocaleString()
      ));

      row.appendChild(info);

      const acts = el('div', {
        class: 'card--list__actions',
      });

      acts.appendChild(el('button', {
        class: 'btn sm',
        type: 'button',

        onClick: () =>
          confirmDialog({
            title:
              'Restore revision ' +
              rev.revision +
              '?',

            message:
              'Its content becomes the current draft. Nothing is deleted: this creates a new revision.',

            confirmText: 'Restore',

            onConfirm: async () => {
              try {
                const page =
                  await Api.adminRestorePageRevision(
                    route,
                    rev.revision
                  );

                st.page = page;
                st.title = page.title;
                st.content =
                  blocksToDocument(page.draft || []);
                st.dirty = false;

                modal.close();

                toast(
                  'Restored as a new draft.',
                  'ok'
                );

                rebuild();
              } catch (ex) {
                toast(
                  ex.message ||
                    'Could not restore',
                  'error'
                );
              }
            },
          }),
      }, 'Restore'));

      row.appendChild(acts);
      box.appendChild(row);
    }

    const modal = openModal({
      title: 'Revision history',
      body: box,
    });
  };

  Api.adminPage(route)
    .then((page) => {
      state.page = page;
      state.title = page.title;
      state.content = blocksToDocument(page.draft || []);
      state.dirty = false;
      rebuild();
    })
    .catch((ex) => {
      clear(body);

      body.appendChild(el(
        'p',
        { class: 'form-error' },
        ex.message || 'Could not load the page.'
      ));
    });
}

export async function renderAdminPages(container, { route } = {}) {
  if (route) {
    pageEditor(container, route);
    return;
  }

  delete document.documentElement.dataset.fullpage;
  clear(container);

  renderContextHeader({
    title: 'Pages',
    sub: 'Public pages an editor can change',
  });

  const {
    frame,
    pane: body,
  } = settingsFrame({
    scope: 'admin',
    active: 'pages',
    contentClass: 'settings-body',
  });

  const wrap = el('div', {
    class: 'page atrium',
  }, frame);

  wrap.appendChild(
    sectionHead(
      'Pages',
      'Public pages an editor can change.'
    )
  );

  body.appendChild(el(
    'p',
    { class: 'muted small' },
    'These pages ship as templates. The sections describing what the software does are accurate everywhere; ' +
    'the fields marked OPERATOR are yours to fill in. Editing a draft does not change what visitors see until you publish.'
  ));

  body.appendChild(pageList());
  wrap.appendChild(body);
  container.appendChild(wrap);
}

export default { renderAdminPages };
