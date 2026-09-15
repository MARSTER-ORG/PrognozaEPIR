'use strict';
// Parser-synchronous loader: keep the proven archive client intact and apply the
// ARCH search adapter before any page inline code reads PrognozaEPIRMessageArchive.
document.write('<script src="message-archive-client-core.js?v=archive-core-20260915"><\/script><script src="arch-search-hotfix.js?v=arch-search-v4-20260915"><\/script>');
