# Governanca GitHub - Siltech Consult

Este repositorio centraliza formularios de issue, taxonomia de labels e
automacao de governanca para os repositorios da organizacao
`Siltech-Consult`.

## Classificacao oficial

Use recursos nativos da organizacao para classificacoes de planejamento:

- Issue Type: `Bug`, `Feature` ou `Task`.
- Priority: `P0`, `P1`, `P2`, `P3`, `P4` ou `P5`.
- Status: `Backlog`, `Ready`, `In progress`, `Blocked`, `Validation`,
  `Frozen` ou `Done`.
- Effort: `XS`, `S`, `M`, `L` ou `XL`.
- Wave: `Onda 1`, `Onda 2` ou `Futuro`.

Nao codifique prioridade, status ou tipo no titulo da issue. Labels devem
descrever apenas contexto tecnico, dependencia ou necessidade de evidencia.

## Labels administrados

O arquivo [`labels.json`](labels.json) e a fonte oficial. A sincronizacao:

- cria labels ausentes;
- atualiza cor e descricao;
- nao remove labels locais adicionais;
- ignora repositorios arquivados.

Execucao local:

```bash
GH_TOKEN=... ./scripts/sync-labels.sh
```

Para limitar repositorios:

```bash
REPOSITORIES="Report-Worker,Windows_Health" ./scripts/sync-labels.sh
```

O workflow `Sync organization labels` exige o secret de organizacao
`ORG_LABEL_SYNC_TOKEN`, com permissao de escrita em Issues nos repositorios.

## Formularios

Os formularios em `.github/ISSUE_TEMPLATE` funcionam como padrao para
repositorios publicos da organizacao que nao tenham formularios proprios.
Cada formulario define o Issue Type correspondente.

## Regras

1. Bug descreve comportamento incorreto, regressao ou risco operacional.
2. Feature descreve capacidade nova percebida por usuario ou integracao.
3. Task descreve manutencao, teste, documentacao, CI ou trabalho interno.
4. P0 bloqueia operacao, seguranca ou confiabilidade basica.
5. P1 deve entrar no proximo ciclo de execucao.
6. P2 e importante, mas pode ser planejado sem interromper entregas atuais.
7. P3-P5 seguem backlog progressivo.
