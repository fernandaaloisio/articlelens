# ArticleLens — Proxy de IA (Render)

Servidor que esconde a chave da Anthropic e exige um token de acesso.
O app (GitHub Pages) chama este proxy em vez de chamar a Anthropic direto.

## Deploy no Render
1. Render → **New** → **Web Service** → conecte o repositório `fernandaaloisio/articlelens`.
2. **Root Directory:** `proxy`
3. **Build Command:** `npm install`
4. **Start Command:** `npm start`
5. **Environment** (variáveis):
   - `ANTHROPIC_API_KEY` = sua chave `sk-ant-...`
   - `ACCESS_TOKEN` = uma senha inventada por você (ex.: 24+ caracteres aleatórios)
   - `ALLOW_ORIGIN` = `https://fernandaaloisio.github.io`  (opcional, restringe quem chama)
6. Plano pago (Starter) para não "dormir".

## No app ArticleLens
- Endpoint: `https://SEU-SERVICO.onrender.com/v1`
- Modelo: o nome que sua conta tem (ex.: `claude-3-5-sonnet-20240620`)
- Chave: o **ACCESS_TOKEN** (NÃO a chave da Anthropic)
