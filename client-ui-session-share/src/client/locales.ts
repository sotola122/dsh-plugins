/**
 * Locale dictionary for the Session-sharing composer block.
 *
 * Every product string this plugin renders lives here; the composer reads the
 * block reason the watcher raises, so this dictionary is the only copy source.
 * @module @anago-harness/client-ui-session-share/src/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'sessionShare'

/** Dictionary keys this plugin renders. */
export type SessionShareLocaleKey = 'composer.heldElsewhere'

/** English copy. */
export const en: Record<SessionShareLocaleKey, string> = {
  'composer.heldElsewhere':
    'This Session is open for writing in another process, so this page cannot send. Stop that process, or continue the Session there.',
}

/** Simplified Chinese copy. */
export const zh: Record<SessionShareLocaleKey, string> = {
  'composer.heldElsewhere':
    '该会话正由另一个进程写入，因此本页无法发送。请停止该进程，或在该处继续该会话。',
}

/** Japanese copy. */
export const ja: Record<SessionShareLocaleKey, string> = {
  'composer.heldElsewhere':
    'このセッションは別のプロセスが書き込み中のため、このページから送信できません。そのプロセスを停止するか、そちらでセッションを続けてください。',
}

/** Spanish copy. */
export const es: Record<SessionShareLocaleKey, string> = {
  'composer.heldElsewhere':
    'Esta sesión está abierta para escritura en otro proceso, así que esta página no puede enviar. Detenga ese proceso o continúe la sesión allí.',
}

/** French copy. */
export const fr: Record<SessionShareLocaleKey, string> = {
  'composer.heldElsewhere':
    'Cette session est ouverte en écriture dans un autre processus, donc cette page ne peut pas envoyer. Arrêtez ce processus, ou continuez la session de ce côté.',
}

/** German copy. */
export const de: Record<SessionShareLocaleKey, string> = {
  'composer.heldElsewhere':
    'Diese Sitzung ist in einem anderen Prozess zum Schreiben geöffnet, daher kann diese Seite nicht senden. Beenden Sie diesen Prozess, oder setzen Sie die Sitzung dort fort.',
}

/** Russian copy. */
export const ru: Record<SessionShareLocaleKey, string> = {
  'composer.heldElsewhere':
    'Эта сессия открыта для записи в другом процессе, поэтому эта страница не может отправлять сообщения. Остановите этот процесс или продолжите сессию там.',
}

/** Portuguese copy. */
export const pt: Record<SessionShareLocaleKey, string> = {
  'composer.heldElsewhere':
    'Esta sessão está aberta para escrita em outro processo, então esta página não pode enviar. Pare esse processo ou continue a sessão lá.',
}
