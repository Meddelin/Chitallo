// Interface language: Russian or English, chosen in onboarding and switchable
// in Settings.
//
// One flat catalogue, `key: [ru, en]`. Keys are typed, so a missing or
// misspelled one is a compile error rather than a blank label at runtime.
//
// Interpolation: `{name}` placeholders, filled from the `vars` argument.
//
// Plurals: a value may carry its forms separated by `|` — three for Russian
// (one / few / many), two for English (one / other). `t()` picks the form from
// `vars.n`, so call sites never think about grammar:
//   t("set.coversTitle", { n: 12 })
//   t("set.books", { n: 5 })               → «5 книг» / "5 books"
//
// Direction B says status out loud in numbers, so a line often carries two of
// them: «84 из 210 страниц сохранены». Only one can govern the grammar, and it
// is always `n` — the total the noun belongs to. Hence the convention across
// this catalogue: `{n}` is the counted noun, `{done}` and friends are the rest.
//   t("tr.pagesKept", { done: 84, n: 210 })   (WP-N)
//
// The chosen language is also the language books are translated INTO: a reader
// who runs Chitallo in Russian wants Russian pages, one who runs it in English
// wants English ones. See TARGET_LANGUAGE.

import { useSyncExternalStore } from "react";

import { isMac, macKeys } from "./host";

export type Lang = "ru" | "en";

const LS_KEY = "pdfer:lang";

// ---- catalogue --------------------------------------------------------------

const S = {
  // -- shared verbs and nouns --
  "ui.close": ["Закрыть · Esc", "Close · Esc"],
  "ui.cancel": ["Отменить", "Cancel"],
  "ui.delete": ["Удалить", "Delete"],
  "ui.download": ["Скачать", "Download"],
  "ui.retry": ["Повторить", "Try again"],
  "ui.restart": ["Перезапустить", "Restart"],
  "ui.open": ["Открыть", "Open"],
  "ui.copy": ["Копировать", "Copy"],
  "ui.copied": ["Скопировано", "Copied"],
  "ui.next": ["Далее", "Next"],
  "ui.none": ["нет", "none"],
  "ui.notFound": ["Ничего не нашлось", "Nothing found"],
  "ui.openFolderFailed": ["Папка не открылась", "The folder did not open"],
  // (WP-N) the checklist and every «not found» line ends in the same verb.
  "ui.install": ["Установить", "Install"],

  // -- app identity --
  "app.tagline": [
    "Локальный перевод книг и вопросы по тексту",
    "Local book translation, and questions about the text",
  ],
  "app.privacy": [
    "Работает офлайн · книги и переводы остаются на компьютере",
    "Works offline · books and translations stay on this computer",
  ],
  "app.privacyAsk": [
    "Кроме «Спросить»: вопрос и фрагмент книги уходят в Claude",
    "Except «Ask»: the question and a fragment of the book go to Claude",
  ],
  "app.about": ["О Chitallo", "About Chitallo"],

  // -- onboarding --
  "ob.langTitle": ["Язык", "Language"],
  "ob.langBody": [
    "Язык интерфейса и язык, на который переводим книги",
    "The language of the interface, and the language we translate books into",
  ],
  "ob.engineFound": ["llama.cpp найден", "llama.cpp found"],
  "ob.engineMissing": ["llama.cpp не найден", "llama.cpp not found"],
  "ob.engineRecheck": ["Проверить снова", "Check again"],
  "ob.weightsTitle": ["Модель перевода", "Translation model"],
  "ob.claudeMissing": ["Claude Code не найден", "Claude Code not found"],
  "ob.claudeDocs": ["Инструкция по установке", "Installation guide"],
  "ob.copyCmd": ["Скопировать команду", "Copy the command"],
  "ob.readyTitle": ["Готово", "Ready"],
  "ob.start": ["Открыть библиотеку", "Open the library"],
  "ob.rerun": ["Пройти заново", "Run it again"],
  // (WP-N) The first run is one checklist, not a five-screen wizard: what is
  // already in place, what is missing and what each item buys — all at once,
  // and the library opens from any line of it.
  "ob.setupTitle": ["Настройка", "Setup"],
  "ob.setupBody": [
    "Любой пункт можно отложить — читалка откроется и так",
    "Any item can wait — the reader opens either way",
  ],
  "ob.rowLang": ["Язык интерфейса и перевода", "Interface and translation language"],
  "ob.claudeWhy": [
    "Нужен только для «Спросить» · подписка Claude Pro или Max",
    "Only «Ask» needs it · a Claude Pro or Max plan",
  ],
  "ob.readyLib": ["Библиотека: {path}", "Library: {path}"],
  "ob.readyTr": ["Перевод: {model} · офлайн", "Translation: {model} · offline"],
  "ob.readyAskOn": ["Спросить: включено", "Ask: on"],
  "ob.readyAskOff": ["Спросить: выключено", "Ask: off"],

  // -- model status vocabulary (one wording, every surface) --
  "model.title": ["Модель перевода", "Translation model"],
  "model.starting": ["Модель перевода: запускается", "Translation model: starting"],
  "model.startingShort": ["Модель запускается · ~20 с", "Model starting · ~20 s"],
  "model.dead": ["Модель не отвечает", "The model is not responding"],
  "model.deadRestart": ["Модель не отвечает · Перезапустить", "Model not responding · Restart"],
  "model.notInstalled": ["Модель не установлена · Скачать {size}", "Model not installed · Download {size}"],
  "model.noEngine": ["llama.cpp не установлен · Как поставить", "llama.cpp not installed · How to install"],
  "model.noEngineBody": [
    "Перевод выполняет llama.cpp · одна команда, и он на месте",
    "Translation runs on llama.cpp · one command puts it in place",
  ],
  "model.downloading": ["Скачиваю модель · {pct}%", "Downloading the model · {pct}%"],
  "model.downloadingDetail": ["Скачиваю модель · {detail}", "Downloading the model · {detail}"],
  "model.downloadingBg": [
    "Скачиваю модель в фоне · можно читать",
    "Downloading the model in the background · you can read",
  ],
  "model.readyHint": [
    "Модель перевода: готова · выделите текст или Alt+клик по абзацу",
    "Translation model: ready · select text, or Alt+click a paragraph",
  ],
  "model.pitch": [
    "Локальный перевод книг · модель скачивается один раз и остаётся на компьютере",
    "Local book translation · the model downloads once and stays on this computer",
  ],
  "model.line": ["HY-MT1.5 · {size} · перевод офлайн", "HY-MT1.5 · {size} · offline translation"],
  "model.downloadCta": ["Скачать модель перевода · {size}", "Download the translation model · {size}"],
  "model.resumeCta": ["Продолжить скачивание · {pct}%", "Resume the download · {pct}%"],
  "model.downloadShort": ["Скачать модель", "Download the model"],
  "model.needed": [
    "Для перевода нужна модель · {size} · один раз, дальше офлайн",
    "Translation needs a model · {size} · once, then offline",
  ],
  "model.neededShort": [
    "Для перевода нужна модель · {size}",
    "Translation needs a model · {size}",
  ],
  "model.later": ["Читать без перевода", "Read without translation"],
  "model.verifying": ["Проверяю файл", "Verifying the file"],
  // (WP-N) A failed download is one row: the cause here, the verb beside it —
  // and the verb is a real button, not a word inside a sentence. Surfaces with
  // no button of their own get the two joined back by dlErrorLine().
  "model.noSpace": ["Не хватает {size}", "{size} short"],
  "model.freeSpace": ["Освободить место", "Free up space"],
  "model.checksum": ["Файл повреждён", "The file is damaged"],
  "model.redownload": ["Скачать заново", "Download again"],
  "model.interrupted": ["Скачивание прервалось", "The download stopped"],
  "model.license": [
    "Лицензия Hunyuan Community · бесплатно, в том числе коммерчески · не действует в ЕС, Великобритании и Южной Корее",
    "Hunyuan Community License · free, commercial use included · not valid in the EU, the UK or South Korea",
  ],
  "model.licenseTerms": ["Условия", "Terms"],
  "model.bgDownload": ["Скачиваю в фоне · Подробности", "Downloading in the background · Details"],
  // (WP-N) the pieces a status line is assembled from, so no surface writes its own
  "model.licenseShort": ["Лицензия Hunyuan Community", "Hunyuan Community License"],

  // -- library --
  "lib.title": ["Библиотека", "Library"],
  "lib.pick": ["Выбрать папку", "Choose a folder"],
  "lib.pickNested": ["Включая все вложенные папки", "Subfolders included"],
  "lib.pickOther": ["Выбрать другую папку", "Choose another folder"],
  "lib.search": ["Найти книгу", "Find a book"],
  "lib.scanning": [
    "Сканирую папку · {n} файл|Сканирую папку · {n} файла|Сканирую папку · {n} файлов",
    "Scanning the folder · {n} file|Scanning the folder · {n} files",
  ],
  "lib.empty": ["PDF не найдены", "No PDFs found"],
  "lib.reading": ["Читаю", "Reading"],
  "lib.all": ["Все", "All"],
  "lib.translating": ["Перевод · {pct}%", "Translation · {pct}%"],
  "lib.stalled": ["Пауза · модель недоступна", "Paused · model unavailable"],
  // (WP-N) the segmented filter took over from the «Reading» / «All books»
  // headings, and a card says its state in one line of numbers.
  "lib.filterTranslating": ["Переводится", "Translating"],
  "lib.notOpened": ["не открывали", "not opened yet"],
  "lib.pageOf": ["стр. {page} из {total}", "p. {page} of {total}"],
  "lib.trPct": ["перевод {pct}%", "translated {pct}%"],

  // -- toolbar / reader --
  "tb.library": ["Библиотека", "Library"],
  "tb.libraryEsc": ["Библиотека · Esc", "Library · Esc"],
  "tb.zoomOut": ["Мельче · Ctrl −", "Zoom out · Ctrl −"],
  "tb.zoomIn": ["Крупнее · Ctrl +", "Zoom in · Ctrl +"],
  "tb.zoomPresets": ["Пресеты масштаба · Ctrl+0 — по ширине", "Zoom presets · Ctrl+0 fits width"],
  "tb.fitWidth": ["По ширине", "Fit width"],
  "tb.fitPage": ["Страница целиком", "Whole page"],
  "tb.col1": ["Одна страница в ряд · Ctrl+1", "One page per row · Ctrl+1"],
  "tb.col2": ["Две страницы в ряд · Ctrl+2", "Two pages per row · Ctrl+2"],
  "tb.colAuto": ["Подобрать по ширине · Ctrl+3", "Fit as many as fit · Ctrl+3"],
  "tb.dark": ["Тёмная тема · D", "Dark theme · D"],
  "tb.light": ["Светлая тема · D", "Light theme · D"],
  "tb.settingsKey": ["Настройки · Ctrl+,", "Settings · Ctrl+,"],
  "tb.ask": ["Спросить", "Ask"],
  "tb.original": ["Оригинал", "Original"],
  "tb.translation": ["Перевод", "Translation"],
  "tb.originalKey": ["Оригинал · T", "Original · T"],
  "tb.translationKey": ["Перевод · T", "Translation · T"],
  // (WP-N) what is left in the pill once the «Translate ▾» menu and the «Ask»
  // button move into the panel: where you are, and two ways in.
  "tb.pageOf": ["{page} / {total}", "{page} / {total}"],
  "tb.pageOfTitle": ["Страница {page} из {total}", "Page {page} of {total}"],
  "tb.palette": ["Палитра команд · Ctrl+K", "Command palette · Ctrl+K"],
  "tb.panel": ["Панель · Ctrl+J", "The panel · Ctrl+J"],

  // -- the panel: three tabs, always in this order (WP-N) --
  "panel.outline": ["Оглавление", "Contents"],
  "panel.ask": ["Спросить", "Ask"],
  "panel.translate": ["Перевод", "Translation"],
  "panel.close": ["Закрыть панель · Esc", "Close the panel · Esc"],
  // A tab badge carries a number when it has one; a paused or broken run shows
  // an amber dot instead, and this is what the dot says when pointed at.
  "panel.attention": ["Требует внимания", "Needs attention"],
  "panel.askBadge": ["{n} сообщение|{n} сообщения|{n} сообщений", "{n} message|{n} messages"],
  "panel.trBadge": ["Перевод · {pct}%", "Translation · {pct}%"],
  "panel.pageOf": ["{page} из {total} · {pct}%", "{page} of {total} · {pct}%"],

  // -- refusals: cause on the left, verb on the right, one line each (WP-N) --
  "err.needOcr": ["Нет текстового слоя · нужен OCR", "No text layer · it needs OCR"],
  "err.whatIsThis": ["Что это значит", "What this means"],
  // (WP-N) Одно предложение под отказом по скану: что именно случилось и что с
  // этим делать. Разворачивается «Что это значит» прямо в карточке вкладки.
  "err.needOcrBody": [
    "Страницы книги — картинки · распознайте текст в другой программе, и перевод пойдёт",
    "The pages are images · run text recognition elsewhere, then the translation will work",
  ],
  "err.notOpened": ["Не открылся", "Did not open"],
  "err.exportPdf": ["Экспортировать в PDF не вышло · {reason}", "Export to PDF failed · {reason}"],
  "err.exportHtml": ["Экспортировать в HTML не вышло · {reason}", "Export to HTML failed · {reason}"],
  "err.noDiskSpace": ["нет места на диске", "no space on the disk"],

  // -- the «Translation» tab (WP-N: the «Translate ▾» menu it replaced is gone) --
  "tr.modelGone": [" · модель недоступна", " · model unavailable"],
  "tr.pause": ["Приостановить", "Pause"],
  "tr.pagesKept": [
    "{done} из {n} страница сохранена|{done} из {n} страницы сохранены|{done} из {n} страниц сохранены",
    "{done} of {n} page saved|{done} of {n} pages saved",
  ],
  "tr.startTitle": [
    "Вся книга переводится офлайн · прервать можно в любой момент",
    "The whole book is translated offline · you can stop at any moment",
  ],
  "tr.start": [
    "Перевести книгу · {n} страница|Перевести книгу · {n} страницы|Перевести книгу · {n} страниц",
    "Translate the book · {n} page|Translate the book · {n} pages",
  ],
  "tr.resumeTitle": ["Продолжить перевод · {done} из {total}", "Resume translating · {done} of {total}"],
  "tr.updateTitle": [
    "Пересобрать страницы и доперевести изменившееся",
    "Rebuild the pages and translate only what changed",
  ],
  "tr.update": ["Обновить перевод", "Update the translation"],
  "tr.updateResume": ["Продолжить обновление · {pct}%", "Resume the update · {pct}%"],
  "tr.redoWarn": [
    "Удалить перевод: {n} страница|Удалить перевод: {n} страницы|Удалить перевод: {n} страниц",
    "Delete the translation: {n} page|Delete the translation: {n} pages",
  ],
  "tr.redoConfirm": ["Удалить и перевести заново", "Delete and translate again"],
  "tr.redoTitle": [
    "Удалить перевод и перевести книгу заново",
    "Delete the translation and translate the book again",
  ],
  "tr.redo": ["Перевести заново", "Translate again"],
  "tr.pdfPreparing": ["Готовлю PDF", "Preparing the PDF"],
  "tr.exportPdfTitle": [
    "Сохранить перевод в PDF с картинками оригинала",
    "Save the translation as a PDF with the original pictures",
  ],
  "tr.exportPdf": ["Экспортировать в PDF", "Export to PDF"],
  "tr.exportPartial": [
    "{done} из {n} страница|{done} из {n} страницы|{done} из {n} страниц",
    "{done} of {n} page|{done} of {n} pages",
  ],
  "tr.exportHtmlTitle": ["Сохранить перевод в HTML", "Save the translation as HTML"],
  "tr.exportHtml": ["Экспортировать в HTML", "Export to HTML"],
  "tr.glossaryTitle": [
    "Термины книги и их переводы · применяются при переводе",
    "The book's terms and their translations · applied while translating",
  ],
  "tr.glossary": ["Открыть глоссарий", "Open the glossary"],
  "tr.etaMin": [" · осталось ~{n} мин", " · ~{n} min left"],
  "tr.etaMinSub": [" · осталось <1 мин", " · <1 min left"],
  "tr.etaHour": [" · осталось ~{n} ч", " · ~{n} h left"],
  "tr.untitled": ["перевод", "translation"],
  // (WP-N) One card holds the run: a state, its numbers, and two verbs. These
  // are the four states it can be in, and the words on those verbs.
  "tr.stateIdle": ["Перевод не начат", "Not started"],
  "tr.stateRunning": ["Идёт", "Running"],
  "tr.statePaused": ["Пауза", "Paused"],
  "tr.stateDone": ["Книга переведена", "The book is translated"],
  // (WP-N) Файл книги не переоткрылся под прогон: причина печатается строкой в
  // карточке, глагол рядом — t("ui.retry"). Тоста для этого больше нет.
  "tr.startFailed": ["Прогон не начался", "The run did not start"],
  "tr.resumeShort": ["Продолжить", "Resume"],
  "tr.checkModel": ["Проверить модель", "Check the model"],
  // The three things a selection can do, spelled out once in the panel instead
  // of hovering over the library as a hint bar.
  "tr.selectionTitle": ["Что умеет выделение", "What a selection can do"],
  "tr.selTranslate": ["Перевести выделенное", "Translate the selection"],
  "tr.selPara": ["Перевести абзац", "Translate a paragraph"],
  "tr.selParaKey": ["Alt + клик", "Alt + click"],
  "tr.selToggle": ["Перевод и оригинал", "Translation and original"],

  // -- selection bar & popover --
  "sel.originalTitle": ["Показать оригинал · O", "Show the original · O"],
  "sel.translateTitle": ["Перевести выделенное · Enter", "Translate the selection · Enter"],
  "sel.translate": ["Перевести", "Translate"],
  "sel.askTitle": ["Спросить о фрагменте", "Ask about this fragment"],
  // (WP-N) the pill itself: three verbs, no explanations. The keys they answer
  // to live in the tooltips above, not in the labels.
  "sel.original": ["Оригинал", "Original"],
  "sel.ask": ["Спросить", "Ask"],
  // The popover says what it is doing in its footer and what went wrong in its
  // body — cause on the left, the verb out of it on the right.
  "pop.translating": ["Перевожу…", "Translating…"],
  "pop.took": ["HY-MT1.5 · {sec} с", "HY-MT1.5 · {sec} s"],
  "pop.modelGone": ["Модель недоступна", "Model unavailable"],
  "pop.check": ["Проверить", "Check"],
  "pop.failed": ["Не удалось перевести", "Translation failed"],
  "pop.altHint": ["Alt+клик — перевести абзац", "Alt+click — translate the paragraph"],

  // -- glossary modal --
  "gl.title": ["Глоссарий", "Glossary"],
  "gl.placeholder": [
    "attention = внимание\nпо одной паре на строку",
    "attention = attention\none pair per line",
  ],
  "gl.replaceWarn": [
    "Заменить список · ручные правки пропадут",
    "Replace the list · manual edits are lost",
  ],
  "gl.replace": ["Заменить", "Replace"],
  "gl.rebuildTitle": [
    "Пересобрать глоссарий с нуля · текущий список будет заменён",
    "Rebuild the glossary from scratch · the current list is replaced",
  ],
  "gl.buildTitle": [
    "Найти термины во всей книге и перевести их локальной моделью",
    "Find the book's terms and translate them with the local model",
  ],
  "gl.rebuild": ["Собрать заново", "Rebuild"],
  "gl.build": ["Собрать глоссарий", "Build the glossary"],
  "gl.mainModelNote": [
    "Термины переведены основной моделью · качество ниже",
    "Terms translated by the main model · the quality is lower",
  ],
  "gl.estimate": ["~2–3 мин на всю книгу", "~2–3 min for the whole book"],
  "gl.added": [
    "Добавлен {n} термин|Добавлено {n} термина|Добавлено {n} терминов",
    "{n} term added|{n} terms added",
  ],
  "gl.skipped": [" · без перевода {n}", " · {n} untranslated"],
  "gl.mining": ["Ищу термины · {done} из {total}", "Finding terms · {done} of {total}"],
  "gl.loading": ["Загружаю модель · до 30 с", "Loading the model · up to 30 s"],
  "gl.translating": ["Перевожу термины · {done} из {total}", "Translating terms · {done} of {total}"],
  "gl.stopTitle": [
    "Остановить · уже переведённые термины останутся",
    "Stop · the terms already translated stay",
  ],
  "gl.stop": ["Остановить", "Stop"],
  "gl.noTerms": ["Терминов не нашлось", "No terms found"],
  "gl.failed": ["Глоссарий не собрался · Повторить", "The glossary did not build · Try again"],
  "gl.retranslateTitle": [
    "Удалить сохранённый перевод и перевести заново с текущим глоссарием",
    "Delete the saved translation and translate again with the current glossary",
  ],
  "gl.retranslate": ["Перевести заново", "Translate again"],
  "gl.auxProgress": ["Модель терминов · {detail}", "Term model · {detail}"],
  "gl.auxPitch": [
    "Термины точнее с моделью терминов · {size} · Apache-2.0",
    "Terms are sharper with the term model · {size} · Apache-2.0",
  ],
  "gl.auxResume": ["Продолжить · {pct}%", "Resume · {pct}%"],

  // -- find bar --
  "find.placeholder": ["Найти в книге", "Find in this book"],
  // One counter, always the same shape: nothing found is «0 из 0», not a
  // sentence taking the numbers' place. (WP-N)
  "find.count": ["{done} из {n}", "{done} of {n}"],
  "find.prev": ["Предыдущее · Shift+Enter", "Previous · Shift+Enter"],
  "find.next": ["Следующее · Enter", "Next · Enter"],

  // -- outline / go to page --
  "out.pagePlaceholder": ["Страница или заголовок", "Page or heading"],
  "out.pageLabel": ["Номер страницы", "Page number"],
  "out.noToc": ["Оглавления нет · Перейти к странице", "No contents · Go to a page"],

  // -- command palette --
  "pal.page": ["Перейти на страницу {n}", "Go to page {n}"],
  "pal.bookTag": ["книга", "book"],
  "pal.findQ": ["Найти в книге · {q}", "Find in this book · {q}"],
  "pal.placeholder": ["Команда, страница или книга", "Command, page or book"],
  "pal.placeholderNoDoc": ["Команда или книга", "Command or book"],
  // (WP-N) The empty palette is a cheat-sheet, and a cheat-sheet of twenty
  // rows needs shelves. Four, in this order, always.
  "pal.grpBook": ["Книга", "Book"],
  "pal.grpView": ["Вид", "View"],
  "pal.grpTr": ["Перевод", "Translation"],
  "pal.grpJump": ["Переход", "Jump"],

  // -- command palette entries + context menu --
  "cmd.toc": ["Открыть оглавление", "Open the contents"],
  "cmd.find": ["Найти в книге", "Find in this book"],
  "cmd.showOriginal": ["Показать оригинал", "Show the original"],
  "cmd.showTranslation": ["Показать перевод", "Show the translation"],
  "cmd.originalSel": ["Показать оригинал выделенного", "Show the original of the selection"],
  "cmd.pauseTr": ["Приостановить перевод", "Pause translating"],
  "cmd.translateBook": ["Перевести книгу", "Translate the book"],
  "cmd.resumeTr": ["Продолжить перевод · {pct}%", "Resume translating · {pct}%"],
  "cmd.zoomIn": ["Крупнее", "Zoom in"],
  "cmd.zoomOut": ["Мельче", "Zoom out"],
  "cmd.col1": ["Показать одну страницу в ряд", "Show one page per row"],
  "cmd.col2": ["Показать две страницы в ряд", "Show two pages per row"],
  "cmd.colAuto": ["Подобрать по ширине", "Fit as many as fit"],
  "cmd.histBack": ["Назад по переходам", "Back through jumps"],
  "cmd.histFwd": ["Вперёд по переходам", "Forward through jumps"],
  "cmd.openFile": ["Открыть файл", "Open a file"],
  "cmd.lightTheme": ["Светлая тема", "Light theme"],
  "cmd.darkTheme": ["Тёмная тема", "Dark theme"],
  "cmd.keys": ["Клавиши", "Keyboard"],
  "cmd.settings": ["Настройки", "Settings"],
  // (WP-N) A button in the pill can be a noun — the icon and the place say the
  // rest. In a list of twenty rows every command is a verb, so the palette
  // renames the first two for itself; the third is the syntax of the page
  // jump, which only the palette can teach.
  "cmd.openLibrary": ["Открыть библиотеку", "Open the library"],
  "cmd.fitWidth": ["Уместить по ширине", "Fit to width"],
  "cmd.goToPage": ["Перейти на страницу", "Go to a page"],
  // (WP-N) the palette gained what the «Translate ▾» menu used to hold
  "ctx.revealInFolder": ["Показать в папке", "Reveal in folder"],
  "ctx.addToGlossary": ["Добавить в глоссарий", "Add to the glossary"],
  "ctx.openInBrowser": ["Открыть в браузере", "Open in the browser"],
  "ctx.copyLink": ["Копировать ссылку", "Copy the link"],
  "ctx.originalPara": ["Оригинал абзаца", "Original of the paragraph"],
  "ctx.translatePara": ["Перевести абзац", "Translate this paragraph"],

  // -- shortcuts overlay --
  "keys.title": ["Клавиши", "Keyboard"],
  "keys.wheel": ["колесо", "wheel"],
  "keys.click": ["клик", "click"],
  "keys.reading": ["Чтение", "Reading"],
  "keys.view": ["Вид", "View"],
  "keys.book": ["Книга", "Book"],
  "keys.translation": ["Перевод", "Translation"],
  "keys.screenFwd": ["Экран вперёд", "Screen forward"],
  "keys.screenBack": ["Экран назад", "Screen back"],
  "keys.scroll": ["Прокрутка", "Scroll"],
  "keys.ends": ["Начало и конец книги", "Start and end of the book"],
  "keys.jumps": ["Назад и вперёд по переходам", "Back and forward through jumps"],
  "keys.zoom": ["Масштаб", "Zoom"],
  "keys.fitWidth": ["По ширине", "Fit width"],
  "keys.columns": ["Колонки: одна, две, авто", "Columns: one, two, auto"],
  "keys.darkTheme": ["Тёмная тема", "Dark theme"],
  "keys.palette": ["Палитра команд", "Command palette"],
  "keys.find": ["Найти в книге", "Find in this book"],
  "keys.openFile": ["Открыть файл", "Open a file"],
  "keys.settings": ["Настройки", "Settings"],
  "keys.close": ["Закрыть", "Close"],
  "keys.keys": ["Клавиши", "Keyboard"],
  "keys.trToggle": ["Перевод / оригинал", "Translation / original"],
  "keys.trPara": ["Перевод абзаца", "Translate a paragraph"],
  "keys.origSel": ["Оригинал выделенного", "Original of the selection"],
  "keys.trSel": ["Перевести выделенное", "Translate the selection"],
  "keys.ask": ["Спросить", "Ask"],
  "keys.askQuick": ["Быстрые команды в «Спросить»", "Quick commands in «Ask»"],

  // -- settings --
  "set.title": ["Настройки", "Settings"],
  "set.theme": ["Тема", "Theme"],
  "set.dark": ["Тёмная", "Dark"],
  "set.light": ["Светлая", "Light"],
  "set.language": ["Язык", "Language"],
  "set.trFont": ["Размер текста перевода", "Translated text size"],
  "set.trFontTitle": ["Кегль перевода при масштабе 100%", "Type size of the translation at 100% zoom"],
  "set.reset": ["Сбросить", "Reset"],
  "set.libFolder": ["Папка библиотеки", "Library folder"],
  "set.noFolder": ["не выбрана", "not chosen"],
  "set.change": ["Сменить", "Change"],
  "set.models": ["Модели", "Models"],
  "set.modelTr": ["Модель перевода", "Translation model"],
  "set.modelTrDesc": ["HY-MT1.5", "HY-MT1.5"],
  "set.modelTrConfirm": [
    "Удалить модель: {size} · перевод остановится",
    "Delete the model: {size} · translation stops",
  ],
  "set.modelTerms": ["Модель терминов", "Term model"],
  "set.modelTermsDesc": ["Qwen3.5", "Qwen3.5"],
  "set.modelTermsConfirm": ["Удалить модель: {size}", "Delete the model: {size}"],
  "set.engine": ["Движок", "Engine"],
  "set.engineReady": ["llama.cpp · найден", "llama.cpp · found"],
  "set.engineMissing": ["llama.cpp · не найден", "llama.cpp · not found"],
  "set.claude": ["Claude Code", "Claude Code"],
  "set.claudeReady": ["подключён", "connected"],
  "set.claudeMissing": ["не найден", "not found"],
  "set.onDisk": ["{size}", "{size}"],
  "set.notInstalled": ["не установлена", "not installed"],
  "set.downloaded": ["скачано {pct}%", "{pct}% downloaded"],
  "set.resume": ["Продолжить", "Resume"],
  "set.deleteBusy": ["Скачиваю модель · Отменить", "Downloading the model · Cancel it"],
  "set.deleteFail": [
    "Файл занят другим процессом · Повторить",
    "Another process is holding the file · Try again",
  ],
  "set.storage": ["Хранилище", "Storage"],
  "set.translations": ["Переводы книг", "Book translations"],
  "set.books": ["{n} книга|{n} книги|{n} книг", "{n} book|{n} books"],
  "set.collapse": ["Свернуть", "Collapse"],
  "set.byBook": ["По книгам", "By book"],
  "set.clear": ["Очистить", "Clear"],
  "set.busyTr": ["Перевожу книгу · Приостановить", "Translating a book · Pause it"],
  // Destructive lines name the volume — books and gigabytes both. (WP-N)
  "set.clearAllWarn": [
    "Удалить переводы: {n} книга, {size}|Удалить переводы: {n} книги, {size}|Удалить переводы: {n} книг, {size}",
    "Delete the translations: {n} book, {size}|Delete the translations: {n} books, {size}",
  ],
  "set.clearAll": ["Удалить переводы", "Delete the translations"],
  "set.clearOneWarn": [
    "Удалить перевод: {n} страница|Удалить перевод: {n} страницы|Удалить перевод: {n} страниц",
    "Delete the translation: {n} page|Delete the translation: {n} pages",
  ],
  "set.clearOne": ["Удалить перевод", "Delete the translation"],
  "set.exportTxtRow": ["Перевод открытой книги", "Translation of the open book"],
  "set.exportTxtTitle": [
    "Сохранить перевод простым текстом, без картинок",
    "Save the translation as plain text, no pictures",
  ],
  "set.exportTxt": ["Экспортировать в TXT", "Export to TXT"],
  "set.covers": ["Обложки библиотеки", "Library covers"],
  "set.coversTitle": [
    "Пересобрать обложки: {n} книга|Пересобрать обложки: {n} книги|Пересобрать обложки: {n} книг",
    "Rebuild the covers: {n} book|Rebuild the covers: {n} books",
  ],
  "set.setup": ["Настройка", "Setup"],

  // -- граф знаний --
  // Вторая половина библиотеки: узлы книг, людей и понятий, происхождение
  // каждой книги (кто вообще имеет право её разбирать) и состояние сборки —
  // числами, вслух. Отсюда же «Спросить» узнаёт, что в граф надо заглянуть
  // раньше, чем в интернет.
  "gr.view.grid": ["Сетка", "Grid"],
  "gr.view.graph": ["Граф", "Graph"],
  "gr.title": ["Граф знаний", "Knowledge graph"],
  // (WP-N) Отказ — это состояние слева и глагол справа, в одной строке: сам
  // граф сказать о себе больше нечего, а обещание «наполнится когда-нибудь»
  // выхода читателю не давало.
  "gr.empty": ["Граф пуст", "The graph is empty"],
  "gr.buildAll": [
    "Собрать граф: {n} книга|Собрать граф: {n} книги|Собрать граф: {n} книг",
    "Build the graph: {n} book|Build the graph: {n} books",
  ],
  "gr.emptyOff": ["Автосборка выключена", "Auto-build is off"],
  "gr.autoOn": ["Включить", "Turn on"],
  "gr.search": ["Найти в графе", "Search the graph"],
  // (WP-N) «Ничего не найдено» жило здесь для плашки поверх холста. Плашки
  // больше нет: счёт стоит в самом поле поиска, и ноль в нём и есть весь ответ.
  // Ключ снят на сборке — на него не ссылался никто.
  // (WP-N) Размер графа — это две величины сразу, и грамматику ведёт первая:
  // {n} — книги, которым узлы принадлежат, {m} — сами понятия.
  "gr.stats": [
    "{n} книга · {m} понятий|{n} книги · {m} понятий|{n} книг · {m} понятий",
    "{n} book · {m} concepts|{n} books · {m} concepts",
  ],
  "gr.building": ["Собираю граф · {done} из {n}", "Building the graph · {done} of {n}"],
  // Провал разбора одной книги: имя слева, глагол «Перестроить» — справа в той
  // же строке. Прежде о нём не говорилось нигде, а счётчик сборки считал
  // упавший прогон за идущий (WP-N).
  "gr.failed": ["{title} не разобралась", "{title} could not be read"],
  // Сколько понятий вообще нарисовано: потолок картинки, а не отбор — поэтому
  // отдельной подписью, а не подсказкой над голой дробью (WP-N).
  "gr.drawn": ["нарисовано {n} из {m}", "{n} of {m} drawn"],
  "gr.queued": [
    "в очереди {n} книга|в очереди {n} книги|в очереди {n} книг",
    "{n} book queued|{n} books queued",
  ],
  "gr.kind.book": ["Книги", "Books"],
  "gr.kind.person": ["Люди", "People"],
  "gr.kind.org": ["Организации", "Organisations"],
  "gr.kind.place": ["Места", "Places"],
  "gr.kind.work": ["Труды", "Works"],
  "gr.kind.topic": ["Темы", "Topics"],
  "gr.kind.term": ["Термины", "Terms"],
  // Происхождение книги решает, кто её читает, поэтому названо словами читателя,
  // а не движка: «лицензионная» и «открытая», а не «local» и «remote».
  "gr.prov.book": ["Лицензионная книга", "Licensed book"],
  "gr.prov.article": ["Открытая статья", "Open article"],
  "gr.prov.unknown": ["Происхождение неясно", "Origin unclear"],
  "gr.prov.why": ["Показать доказательства", "Show the evidence"],
  "gr.prov.change": ["Изменить", "Change"],
  // Абзац из трёх предложений в карточке шириной с панель никто не читает, и
  // он там же лишний: полное объяснение стоит в «Настройках» (gr.claudeHint),
  // а карточке хватает одной мысли — кто читает лицензионную книгу (WP-N).
  "gr.prov.hint": [
    "Лицензионную книгу читает только локальная модель",
    "A licensed book is read by the local model alone",
  ],
  // Состояние, а не обрубок предложения: строка стоит сама по себе, поэтому
  // начинается с заглавной и называет движок именем (WP-N).
  "gr.engine.local": ["Локальная модель", "Local model"],
  "gr.engine.claude": ["Claude Code", "Claude Code"],
  "gr.engine.none": ["Без модели", "No model"],
  "gr.mentions": ["{n} упоминание|{n} упоминания|{n} упоминаний", "{n} mention|{n} mentions"],
  "gr.inBooks": ["В книгах", "In books"],
  "gr.related": ["Рядом", "Nearby"],
  "gr.openBook": ["Открыть книгу", "Open the book"],
  "gr.page": ["с. {n}", "p. {n}"],
  // «Разобрать глубже» здесь когда-то было отдельной строкой, и это была вторая
  // подпись под одним и тем же действием: карточка выбранной книги предлагает
  // «Перестроить», а перестройка и есть повторный глубокий разбор — с уже
  // исправленным происхождением. Второй глагол только заставлял бы читателя
  // гадать, чем эти кнопки отличаются, поэтому его нет.
  "gr.rebuild": ["Перестроить", "Rebuild"],
  "gr.rebuildAll": ["Перестроить весь граф", "Rebuild the whole graph"],
  "gr.stopAll": ["Остановить сборку", "Stop building"],
  "gr.reset": ["Свести к центру", "Recentre"],
  "gr.auto": ["Строить граф знаний автоматически", "Build the knowledge graph automatically"],
  // Половину фразы («книга попадает в граф сразу») читатель и так видит по
  // очереди в настройках; вторая половина — единственное место, где сказано,
  // ЧЕМ книгу читают, и без неё галочка ниже выглядела бы беспричинной.
  "gr.autoHint": [
    "Новая книга попадает в граф, как только её найдёт библиотека. Разбирает её локальная модель — пока не включена строка ниже.",
    "A new book enters the graph as soon as the library finds it. The local model reads it — unless the row below is on.",
  ],
  // Строка о том, что уходит с компьютера, поэтому названа глаголом читателя и
  // говорит обе стороны сразу: что уходит и что не уходит никогда. «По умолчанию
  // выключено» стоит последним — это ответ на вопрос, который читатель задаёт
  // себе первым, увидев здесь чужое имя.
  "gr.claude": [
    "Разбирать открытые статьи через Claude Code",
    "Read open articles through Claude Code",
  ],
  "gr.claudeHint": [
    "Файл, опознанный как открытая статья, отправляется на прочтение в Claude Code: в граф идут её заголовок, авторы и добытые из неё понятия, а не текст страниц. Лицензионную книгу — и всё, чьё происхождение неясно, — читает локальная модель, и с компьютера они не уходят. По умолчанию выключено.",
    "A file recognised as an open article is sent to Claude Code to be read: what reaches the graph is its title, its authors and the terms mined from it, never the text of its pages. A licensed book, and anything whose origin is unclear, is read by the local model and does not leave this computer. Off by default.",
  ],
  "gr.clear": ["Очистить граф", "Clear the graph"],
  // Без модели граф не пустой, но и не умный. Состояние — строкой с глаголом
  // рядом, перечисление — тихой припиской под ней: одна строка, одна мысль (WP-N).
  "gr.noModel": ["Модель не установлена", "No model installed"],
  "gr.noModelHint": [
    "В графе — заголовки, метки и термины из текста",
    "The graph holds titles, tags and terms mined from the text",
  ],
  "gr.filter": ["Показывать", "Show"],
  "gr.selectHint": ["Выбрать узел в графе", "Pick a node in the graph"],
  "ask.graphCtx": ["Из вашей библиотеки", "From your library"],
  // Appended to ask.system whenever the graph has something to say. It is a
  // rule about ORDER, not a licence to cite: the library first, own knowledge
  // second, the web only if the question needs today's facts. Same hazard as
  // ask.viz — no «|» anywhere in this string, or t() would cut the rule short
  // at the first pipe and the model would never see the last sentence.
  "ask.graph": [
    "Порядок поиска. Сперва смотри в блок «Из вашей библиотеки» — это выжимка из графа знаний, собранного по книгам самого читателя. Если ответ есть там, отвечай по нему и называй книги, на которые опираешься. Если граф отвечает не до конца, договаривай из собственных знаний и прямо скажи, чего в библиотеке нет. В интернет ходи только тогда, когда ответу и правда нужны свежие факты.",
    "Where to look, and in what order. Start with the «From your library» block: it is the reader's own knowledge graph, boiled down. If the answer is there, build on it and name the books you leaned on. If the graph only gets you part of the way, finish from your own knowledge and say plainly what the library does not cover. Go to the web only when the answer genuinely needs current facts.",
  ],
  "ask.graphUsed": ["По графу библиотеки", "From the library graph"],
  // (WP-N) Подпись под ответом: кто ответил и за сколько. «Спросить» —
  // единственное место, где приложение выходит в сеть, и эта строка делает
  // границу видимой. Не фраза, а факт: имя модели · время, как у поповера
  // перевода. Имя приходит из потока машинным идентификатором и очеловечивается
  // на месте (modelName); когда его в потоке не было — имя самого CLI.
  "ask.took": ["{model} · {sec} с", "{model} · {sec} s"],
  "set.web": ["Разрешить поиск в интернете", "Allow web search"],
  "set.webHint": [
    "«Спросить» сперва смотрит в граф знаний, потом в собственные знания. С этой галочкой Claude Code сможет дополнительно искать в интернете — вопрос и найденные ссылки уйдут в сеть.",
    "«Ask» looks in the knowledge graph first, then in its own knowledge. Tick this and Claude Code may search the web as well — the question, and the links it comes back with, go out over the network.",
  ],

  // -- about --
  "about.title": ["О программе", "About"],
  "about.thirdParty": ["Собрано на", "Built on"],
  "about.hyLicense": [
    "Бесплатно, в том числе коммерчески · не действует в ЕС, Великобритании и Южной Корее",
    "Free, commercial use included · not valid in the EU, the UK or South Korea",
  ],
  "about.modelHy": ["Модель HY-MT1.5-7B · Tencent", "HY-MT1.5-7B model · Tencent"],
  "about.modelQwen": ["Модель Qwen3.5-4B · Alibaba", "Qwen3.5-4B model · Alibaba"],

  // -- ask sidebar --
  "ask.appOnlyBadge": ["Доступно только в приложении", "Available only in the app"],
  "ask.empty": [
    "Вопрос о книге. Выделенный фрагмент попадёт в вопрос",
    "A question about the book. The selected fragment goes with it",
  ],
  "ask.quotePagePrefix": ["стр. {n} — ", "p. {n} — "],
  "ask.threads": ["Беседы по книге", "Conversations about this book"],
  "ask.threadsN": ["Беседы · {n}", "Conversations · {n}"],
  "ask.threadsHeading": ["Беседы", "Conversations"],
  "ask.threadsEmpty": ["Бесед пока нет", "No conversations yet"],
  "ask.newThreadTitle": ["Новая беседа", "New conversation"],
  "ask.newThreadEmpty": [
    "Новая беседа — эта беседа уже пустая",
    "New conversation — this one is already empty",
  ],
  "ask.deleteThread": ["Удалить беседу", "Delete this conversation"],
  "ask.deleteThreadWarn": ["Удалить беседу и её память", "Delete the conversation and its memory"],
  "ask.hideSuggestions": ["Скрыть подсказки", "Hide the suggestions"],
  "ask.removeFragment": ["Убрать фрагмент", "Remove the fragment"],
  "ask.cmdNotFound": ["Команда не найдена", "No such command"],
  "ask.placeholder": ["Вопрос о книге · / — команды", "A question about the book · / for commands"],
  "ask.quickCommands": ["Быстрые команды · /", "Quick commands · /"],
  "ask.quickCommandsShort": ["Быстрые команды", "Quick commands"],
  "ask.stop": ["Остановить", "Stop"],
  "ask.send": ["Отправить · Enter", "Send · Enter"],
  "ask.stopped": ["Остановлено", "Stopped"],
  "ask.pageShort": ["стр. {n}: ", "p. {n}: "],
  "ask.newThread": ["Новая беседа", "New conversation"],
  "ask.emptyThread": ["пусто", "empty"],
  "ask.msgs": ["{n} сообщение|{n} сообщения|{n} сообщений", "{n} message|{n} messages"],
  "ask.today": ["Сегодня", "Today"],
  "ask.yesterday": ["Вчера", "Yesterday"],
  "ask.earlier": ["Раньше", "Earlier"],
  "ask.defaultQ": ["Объясни этот фрагмент", "Explain this fragment"],
  "ask.simpler": ["Объясни проще", "Explain it more simply"],
  "ask.linkTopicMsg": ["Как это связано с темой книги?", "How does this relate to the book's subject?"],
  "ask.cmdExplain": ["Объяснить выделенное", "Explain the selection"],
  "ask.cmdTerm": ["Определить термин", "Define the term"],
  "ask.cmdTermMsg": [
    "Что означает этот термин в контексте книги?",
    "What does this term mean in the context of this book?",
  ],
  "ask.cmdPage": ["Пересказать страницу", "Summarize the page"],
  "ask.cmdPageMsg": ["Перескажи страницу {n} своими словами", "Summarize page {n} in your own words"],
  "ask.cmdLink": ["Связать с темой книги", "Relate it to the book's subject"],
  "ask.cmdSimpler": ["Объяснить проще", "Explain it more simply"],
  // One command, not one per form: the point of ask.viz is that the model picks
  // the shape. «Наглядно» asks for the best one — and explicitly licenses «none
  // of them», so the command cannot be read as an order to draw something.
  "ask.cmdChart": ["Показать наглядно", "Show it visually"],
  "ask.cmdChartMsg": [
    "Покажи содержание страницы {n} наглядно — графиком, схемой или таблицей, смотря что подходит. Если наглядно тут нечего показывать, так и скажи, без картинки.",
    "Show what is on page {n} visually — a chart, a diagram or a table, whichever fits. If there is nothing here worth a picture, say so plainly and draw none.",
  ],
  "ask.needSeed": ["Выделить фрагмент в книге", "Select a fragment in the book"],
  "ask.needAnswer": ["Задать вопрос", "Ask a question"],
  // (WP-N) the three chips above the field — one tap, no typing
  "ask.chipChapter": ["О чём эта глава", "What this chapter is about"],
  "ask.chipChapterMsg": [
    "О чём эта глава? Ответь коротко, со ссылками на страницы",
    "What is this chapter about? Answer briefly, citing pages",
  ],
  "ask.chipTerms": ["Термины", "Terms"],
  "ask.chipTermsMsg": [
    "Какие термины вводит эта страница и что они значат?",
    "Which terms does this page introduce, and what do they mean?",
  ],
  "ask.chipShort": ["Кратко", "In short"],
  "ask.chipShortMsg": [
    "Перескажи страницу {n} в трёх предложениях",
    "Summarize page {n} in three sentences",
  ],
  "ask.threadOn": ["Беседа · {when}", "Conversation · {when}"],
  "ask.panelWidth": ["Ширина панели", "Panel width"],
  "ask.panelWidthTitle": [
    "Ширина панели · двойной клик вернёт исходную",
    "Panel width · double-click restores the default",
  ],
  "ask.appOnly": [
    "Вопросы к Claude работают только в приложении Chitallo",
    "Asking Claude only works inside the Chitallo app",
  ],
  "ask.emptyAnswer": ["Пустой ответ", "Empty answer"],
  "ask.errUnknown": ["Ошибка · {what}", "Error · {what}"],
  "ask.errUnknownWhat": ["неизвестная", "unknown"],
  "ask.cancelled": ["Запрос отменён", "Request cancelled"],
  // (WP-N) Отказ называет только причину: глагол под ним — кнопка повтора в
  // строке действий сообщения, и второй раз то же слово текстом не пишется.
  // У «не найден» команда установки стоит следующей строкой самого сообщения —
  // она и есть ответ на «как поставить».
  "ask.noAnswer": ["Ответ не пришёл", "No answer came back"],
  "ask.exited": ["Claude Code вышел без ответа", "Claude Code exited without answering"],
  "ask.notFound": ["Claude Code не найден", "Claude Code not found"],
  // The path and the exit detail moved out of the sentence into the quiet line
  // under it — there when you need it, silent when you do not. (WP-N)
  "ask.busy": ["Отвечаю на другой вопрос · Остановить", "Answering another question · Stop it"],
  "ask.launchFail": ["Claude не запустился · {detail}", "Claude did not start · {detail}"],
  // The prompt Claude itself receives — written in the reader's language so the
  // answers come back in it.
  "ask.system": [
    "Ты — помощник в PDF-читалке. Пользователь читает книгу «{title}» и задаёт вопросы о ней по-русски. Отвечай на русском, кратко и по существу. Если вопрос про выделенный фрагмент — объясняй именно его в контексте книги. Ссылайся на номера страниц, когда это уместно. Уместна умеренная markdown-разметка (списки, выделение); без заголовков без необходимости.",
    "You are an assistant inside a PDF reader. The user is reading the book “{title}” and asks questions about it in English. Answer in English, briefly and to the point. If the question is about a selected fragment, explain that fragment in the context of the book. Cite page numbers where it helps. Moderate markdown (lists, emphasis) is welcome; avoid headings unless they earn their place.",
  ],
  // Appended to ask.system. Not a list of syntaxes — a rubric for CHOOSING the
  // shape of an answer, whose standing answer is «prose, write a sentence». The
  // syntaxes come after, and each has to agree with the renderer that reads it:
  // maths is KaTeX with single-dollar inline ON, ```chart is parsed by ChartBlock
  // and ```mermaid by MermaidBlock (components/ai-elements/), so the limits
  // quoted here are the limits those files actually enforce.
  //
  // Three deliberate narrowings, each of which cost an answer somewhere:
  //   * five numbers before a chart — the failure this guards is a bar chart of
  //     two values, which every model reaches for;
  //   * four to seven nodes, and only flowchart TD / stateDiagram-v2 /
  //     sequenceDiagram — everything else is unreadable in a 320 px column, and
  //     mindmap is left out on purpose: it is the most tempting WRONG answer to
  //     «what is X», where a nested list is better;
  //   * one picture per answer, after the prose, never instead of it.
  //
  // NB: no «|» anywhere in this string — t() reads a pipe as a plural split and
  // would silently truncate the system prompt at the first one. Guarded below.
  "ask.viz": [
    "Форма ответа. По умолчанию — проза; в девяти случаях из десяти это и есть верный ответ. Правило одно: рисуй только то, чего не скажешь вслух. Если ответ можно произнести собеседнику и он поймёт — пиши словами. Картинка нужна, когда важна не сама величина, а её форма: ход, перевес, ветвление, порядок. Она не заменяет ответ, а идёт после одной-двух фраз прозы; больше одной картинки в ответе почти никогда не нужно. Перед тем как рисовать, мысленно убери картинку: если ответ и без неё полон, она была украшением. Сомневаешься — не рисуй.\n\nНе рисуй график из двух-трёх чисел, круговую диаграмму из долей, уже названных в тексте, схему-пересказ абзаца и формулу вокруг счёта в уме. Числа, шаги и связи бери только из книги или из вопроса и не придумывай их; страницу-источник называй. Прямая просьба нарисовать снимает пороги, но не этот запрет: чего в книге нет, того не рисуй.\n\nФормулы — исключение: это не картинка, а запись, которой пользуется сама книга, и её пиши смело. LaTeX: $E=mc^2$ внутри строки, $$...$$ отдельным блоком. Доллар в обычном тексте экранируй (\\$5), иначе он утащит полабзаца в формулу. Простое число в формулу не оборачивай.\n\nГрафик — когда чисел пять и больше и в них виден ход или сравнение. Два-три числа просто назови словами. Блок кода с языком chart и JSON внутри:\n\n```chart\n{\"type\": \"line\", \"title\": \"Население, млн\", \"x\": \"year\", \"unit\": \"млн\", \"note\": \"с. 214\", \"series\": [{\"key\": \"ru\", \"label\": \"Россия\"}], \"data\": [{\"year\": 1897, \"ru\": 125.6}, {\"year\": 1926, \"ru\": 147}]}\n```\n\ntype — line, area, bar или pie; x — поле категории (ось X, для pie — название доли); series — ряды, у каждого key (поле в data, латиницей, без пробелов) и label; data — массив объектов. Необязательные: title, xLabel (как назвать колонку x в таблице), unit, note (мелкая строка под графиком, обычно страница), stacked, curve (natural, linear, step). Не больше 5 рядов и 5 долей; на одном графике одна величина, две разные шкалы в одних осях врут; pie — только доли целого; числа пиши числами JSON, подписи по-русски.\n\nСхема — когда важны связи, а не количества, и есть развилка или возврат: от четырёх узлов и не больше семи. Прямая цепочка шагов — это список, а не схема. Разбор понятия на части — тоже список. Блок кода с языком mermaid, сверху вниз, и только три типа: flowchart TD — путь с ветвлением; stateDiagram-v2 — состояния и переходы; sequenceDiagram — обмен между двумя-тремя сторонами.\n\n```mermaid\nflowchart TD\n  A[\"Наблюдение\"] --> B[\"Гипотеза\"]\n  B --> C{\"Опыт сошёлся\"}\n  C -- да --> D[\"Закон\"]\n  C -- нет --> A\n```\n\nПодписи в flowchart всегда в кавычках, два-три слова. Направление LR, subgraph, стили, директивы init и остальные типы не пиши: в узкой панели они нечитаемы. Страницу назови прозой рядом со схемой.\n\nТаблица — обычным markdown, когда сравниваешь несколько объектов по нескольким признакам и строк хотя бы три. Две-три колонки и короткие ячейки, шире панель не примет.",
    "Shape of the answer. Prose is the default; nine times in ten it is the whole answer. One rule decides: draw only what you cannot say out loud. If you could say it across the table and be understood, write it in words. A picture is for when the shape matters more than the value — a trend, a gap, a branch, an order. It never stands in for the answer: a sentence or two of prose comes first, and more than one picture in an answer is almost never needed. Before you draw, take the picture away: if the answer is still complete, it was decoration. In doubt, do not draw.\n\nDo not draw a chart of two or three numbers, a pie of shares already listed in the text, a diagram that retells a paragraph with arrows, or maths around a sum you can do in your head. Take every number, step and link from the book or the question, invent none, name the source page. Asked outright for a picture, the thresholds drop but that ban does not: what is not in the book stays undrawn.\n\nMaths is the exception: not a picture but the notation the book itself uses, so write it freely. LaTeX: $E=mc^2$ inline, $$...$$ as its own block. Escape a literal dollar in prose (\\$5) or it will swallow half a paragraph into a formula. Do not wrap a plain number in maths.\n\nChart — five numbers or more, with a trend or a comparison visible in them. Two or three you simply say in words. A code block tagged chart, with JSON inside:\n\n```chart\n{\"type\": \"line\", \"title\": \"Population, millions\", \"x\": \"year\", \"unit\": \"m\", \"note\": \"p. 214\", \"series\": [{\"key\": \"ru\", \"label\": \"Russia\"}], \"data\": [{\"year\": 1897, \"ru\": 125.6}, {\"year\": 1926, \"ru\": 147}]}\n```\n\ntype — line, area, bar or pie; x — the category field (the X axis, or the slice name for pie); series — the series, each with key (the field in data, ASCII, no spaces) and label; data — an array of objects. Optional: title, xLabel (what to call the x column in the table), unit, note (the small line under the chart, usually the page), stacked, curve (natural, linear, step). At most 5 series and 5 slices; one measure per chart, two scales in one pair of axes lie; pie only for parts of a whole; numbers as JSON numbers, labels in English.\n\nDiagram — when links matter more than quantities and there is a fork or a loop back: four nodes at least, seven at most. A straight run of steps is a list, not a diagram. A concept broken into parts is a list too. A code block tagged mermaid, top down, and only three types: flowchart TD — a path that branches; stateDiagram-v2 — states and transitions; sequenceDiagram — an exchange between two or three sides.\n\n```mermaid\nflowchart TD\n  A[\"Observation\"] --> B[\"Hypothesis\"]\n  B --> C{\"Experiment fits\"}\n  C -- yes --> D[\"Law\"]\n  C -- no --> A\n```\n\nNode labels in flowchart are always quoted, two or three words. No LR, no subgraph, no styling, no init directives, no other type: the panel is too narrow. Name the page in prose beside the diagram.\n\nTable — plain markdown, comparing several things across several properties, at least three rows. Two or three columns with short cells, nothing wider fits.",
  ],
  "ask.quoteFrom": [
    "Фрагмент из книги «{title}»{page}:",
    "A fragment from the book “{title}”{page}:",
  ],
  "ask.quotePage": [" (страница {n})", " (page {n})"],
  "ask.surrounding": ["Окружающий текст страницы:", "Surrounding text on the page:"],
  "ask.question": ["Вопрос: {q}", "Question: {q}"],
  "ask.readingCtx": [
    "Читаю книгу «{title}», сейчас открыта страница {page}.",
    "I am reading the book “{title}”, currently on page {page}.",
  ],
  // (WP-N) Где читатель СЕЙЧАС — уходит с каждым сообщением продолжающейся
  // беседы, а не только с первым: между вопросами книгу листают, и модель,
  // помнящая одну лишь стартовую страницу, отвечает про давно прочитанное.
  "ask.readingHere": [
    "Сейчас я на странице {page} из {total} книги «{title}».",
    "I am now on page {page} of {total} of the book “{title}”.",
  ],
  // Текст самой открытой страницы — только для вопросов, которые про «здесь»
  // (чипы-подсказки, команды «страница» и «наглядно»). Номер стоит в заголовке
  // блока: в две колонки таких блоков два, и модель обязана видеть, где чей.
  "ask.openPage": ["Текст открытой страницы {n}:", "Text of the open page {n}:"],

  // -- charts Claude draws inside an answer (```chart, see chart-block.tsx) --
  "chart.showTable": ["Показать таблицей", "Show as a table"],
  "chart.showChart": ["Показать графиком", "Show as a chart"],
  "chart.drawing": ["Строю график", "Drawing the chart"],
  "chart.other": ["прочее", "other"],
  "chart.broken": ["График не прочитался · Показать текстом", "The chart did not parse · Show as text"],
  "chart.dropped": [
    "не поместился ещё {n} ряд|не поместились ещё {n} ряда|не поместились ещё {n} рядов",
    "{n} more series did not fit|{n} more series did not fit",
  ],

  // -- diagrams Claude draws inside an answer (```mermaid, see mermaid-block.tsx) --
  "diagram.drawing": ["Строю схему", "Drawing the diagram"],
  "diagram.broken": ["Схема не прочиталась · Показать текстом", "The diagram did not parse · Show as text"],

  // -- glossary terminologist (prompts the aux model sees) --
  "term.system": [
    "Ты — терминолог. Тебе дают термин из книги, тематику книги и предложение-контекст. Ответь ТОЛЬКО устоявшимся русским эквивалентом этого термина — без пояснений, без кавычек, без точки в конце. Если термин по общепринятой конвенции не переводится (аббревиатура, имя собственное, название продукта или компании) — верни его без изменений.",
    "You are a terminologist. You are given a term from a book, the book's subject area, and a sentence of context. Answer with ONLY the established English equivalent of that term — no explanation, no quotes, no full stop. If convention leaves the term untranslated (an acronym, a proper name, a product or company name), return it unchanged.",
  ],
  "term.domain": ["Тематика книги (ключевые термины): {domain}", "Subject area (key terms): {domain}"],
  "term.context": ["Контекст: {sample}", "Context: {sample}"],
  "term.term": ["Термин: {term}", "Term: {term}"],

  // -- export document (the generated HTML/PDF) --
  "exp.machineTr": ["Машинный перевод · Chitallo{partial}", "Machine translation · Chitallo{partial}"],
  "exp.partial": [" · {done} из {total} страниц", " · {done} of {total} pages"],
  "exp.pageNotTr": ["страница {n} не переведена", "page {n} is not translated"],
  "exp.pagesNotTr": ["страницы {a}–{b} не переведены", "pages {a}–{b} are not translated"],
  "exp.refPage": ["страница {n} — оригинал без перевода", "page {n} — original, untranslated"],
  "exp.placeholder": ["[таблица или формула]", "[table or formula]"],
  "exp.origPage": ["Страница {n} оригинала", "Page {n} of the original"],
  "exp.figure": ["Рисунок", "Figure"],
  "exp.fragment": ["Фрагмент оригинала", "Fragment of the original"],
  "exp.docTitle": ["{title} — перевод", "{title} — translation"],
  "exp.txtFilter": ["Текст", "Text"],
} as const satisfies Record<string, readonly [string, string]>;

export type Key = keyof typeof S;

// A pipe in a catalogue entry means «plural forms», and t() splits on it before
// it does anything else — so one typed into ordinary prose silently truncates
// that string to its first «form». Nowhere does that hurt more than ask.viz,
// which is a multi-paragraph system prompt: the model would receive it cut off
// mid-sentence and nothing would look broken. Every real plural here counts with
// {n}, so an entry with a pipe and no {n} is the mistake, caught in dev, at
// import time, before anything renders.
if (import.meta.env.DEV) {
  for (const [key, forms] of Object.entries(S)) {
    for (const s of forms) {
      if (s.includes("|") && !s.includes("{n}")) {
        throw new Error(
          `i18n: «${key}» contains a pipe but no {n} — t() will split it into plural forms and drop everything after the first one.`,
        );
      }
    }
  }
}

// ---- language state ---------------------------------------------------------

/// The reader has never chosen: onboarding decides, and until it does nothing
/// should silently guess and stick.
export function chosenLang(): Lang | null {
  const v = localStorage.getItem(LS_KEY);
  return v === "ru" || v === "en" ? v : null;
}

/// Best guess before a choice exists — used for the onboarding screen itself,
/// so the very first sentence is already in a language the reader can read.
function guessLang(): Lang {
  const tags = typeof navigator === "undefined" ? [] : [navigator.language, ...(navigator.languages ?? [])];
  return tags.some((t) => typeof t === "string" && t.toLowerCase().startsWith("ru")) ? "ru" : "en";
}

let current: Lang = chosenLang() ?? guessLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  localStorage.setItem(LS_KEY, l);
  if (l === current) return;
  current = l;
  document.documentElement.lang = l;
  listeners.forEach((fn) => fn());
}

/// Subscribing anywhere in the tree re-renders that subtree on a language
/// switch. App does it once at the root, which covers everything below it.
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}

if (typeof document !== "undefined") document.documentElement.lang = current;

// ---- lookup -----------------------------------------------------------------

type Vars = Record<string, string | number>;

/// Russian has three plural forms, English two. `n` in the vars picks one.
function pluralIndex(n: number, lang: Lang, forms: number): number {
  if (forms < 2) return 0;
  if (lang === "en") return n === 1 ? 0 : 1;
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return 0;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
  return Math.min(2, forms - 1);
}

export function t(key: Key, vars?: Vars): string {
  const entry = S[key] as readonly [string, string];
  let s = current === "ru" ? entry[0] : entry[1];
  if (s.includes("|")) {
    const forms = s.split("|");
    const n = Number(vars?.n ?? 0);
    s = forms[pluralIndex(n, current, forms.length)] ?? forms[0];
  }
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, name: string) =>
      name in vars ? String(vars[name as keyof Vars]) : m,
    );
  }
  // Shortcut hints are written once, with the Windows/Linux names, and turned
  // into ⌘/⌥ here — so no string in the catalogue has to spell both.
  return isMac() ? macKeys(s) : s;
}

// ---- numbers ----------------------------------------------------------------

/// Russian writes 4,6; English writes 4.6. One place, so no call site has to
/// remember which.
export function fmtNum(n: number, digits = 1): string {
  const s = n.toFixed(digits);
  return current === "ru" ? s.replace(".", ",") : s;
}

export function fmtGb(bytes: number): string {
  return `${fmtNum(bytes / 1e9)} ${current === "ru" ? "ГБ" : "GB"}`;
}

/// GB / MB / KB, whichever keeps the number readable.
export function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return fmtGb(bytes);
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} ${current === "ru" ? "МБ" : "MB"}`;
  return `${Math.max(1, Math.round(bytes / 1e3))} ${current === "ru" ? "КБ" : "KB"}`;
}

export function fmtMbps(bps: number): string {
  return `${Math.max(1, Math.round(bps / 1e6))} ${current === "ru" ? "МБ/с" : "MB/s"}`;
}

// ---- the language books are translated INTO ---------------------------------
//
// HY-MT1.5's prompt templates name the target language, in English for the
// basic template and in Chinese for the terminology/contextual ones (that is
// how the model card documents them).

export const TARGET_LANGUAGE: Record<Lang, { en: string; zh: string }> = {
  ru: { en: "Russian", zh: "俄语" },
  en: { en: "English", zh: "英语" },
};

export function targetLanguage(): { en: string; zh: string } {
  return TARGET_LANGUAGE[current];
}
