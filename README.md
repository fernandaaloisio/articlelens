# ArticleLens

Extrator local de **título, autores e e-mails** de publicações acadêmicas (PDF/HTML).
Aplicação web 100% client-side (PDF.js + SheetJS) — o processamento acontece no
navegador; **nenhum dado é enviado a servidores**.

Abra o `index.html` (ou o site publicado). Recursos:
- Upload de PDF/HTML em lote, extração de título/autores/e-mails, exportação CSV/Excel/JSON.
- Pareamento inteligente e-mail↔autor; IA opcional (Ollama local) para casos ambíguos.

> Os dados coletados (planilhas, e-mails) NUNCA fazem parte deste repositório.
