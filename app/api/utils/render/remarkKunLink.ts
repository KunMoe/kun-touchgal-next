import { visit } from 'unist-util-visit'
import { readKunDirective } from '~/utils/markdown/kunDialect'
import type { Plugin } from 'unified'
import type { Node } from 'unist'

const getLinkLabel = (href: string) => {
  try {
    const hostname = new URL(href).hostname
    return hostname || href
  } catch {
    return href
  }
}

export const remarkKunLink: Plugin<[], Node> = () => {
  return (tree) => {
    visit(tree, (node: any) => {
      const attrs = readKunDirective(node, 'kun-link')
      if (attrs) {
        const { href, text } = attrs
        const data = node.data

        data.hName = 'div'
        data.hProperties = {
          'data-kun-link': '',
          className:
            'flex flex-col relative overflow-hidden h-auto outline-hidden text-foreground box-border bg-content1 rounded-large shadow-medium transition-transform-background motion-reduce:transition-none w-full'
        }
        data.hChildren = [
          {
            type: 'element',
            tagName: 'div',
            properties: {
              className:
                'relative flex flex-1 w-full p-3 flex-auto flex-col place-content-inherit align-items-inherit h-auto break-words text-left overflow-y-auto subpixel-antialiased'
            },
            children: [
              {
                type: 'element',
                tagName: 'div',
                properties: { className: 'flex items-center gap-2' },
                children: [
                  {
                    type: 'element',
                    tagName: 'div',
                    properties: {
                      className:
                        'relative max-w-fit min-w-min inline-flex items-center justify-between box-border whitespace-nowrap px-1 h-6 text-tiny rounded-full bg-primary/20 text-primary-600'
                    },
                    children: [
                      {
                        type: 'element',
                        tagName: 'div',
                        properties: {
                          className: 'flex-1 text-inherit font-normal px-1'
                        },
                        children: [{ type: 'text', value: '外部链接' }]
                      }
                    ]
                  },
                  {
                    type: 'element',
                    tagName: 'div',
                    properties: { className: 'text-default-500' },
                    children: [{ type: 'text', value: getLinkLabel(href) }]
                  }
                ]
              },
              {
                type: 'element',
                tagName: 'div',
                properties: { className: 'm-0' },
                children: [{ type: 'text', value: text }]
              },
              {
                type: 'element',
                tagName: 'a',
                properties: {
                  href,
                  className:
                    'relative inline-flex items-center outline-hidden tap-highlight-transparent text-medium text-primary no-underline hover:opacity-hover active:opacity-disabled transition-opacity break-all'
                },
                children: [
                  { type: 'text', value: href },
                  {
                    type: 'element',
                    tagName: 'svg',
                    properties: {
                      'aria-hidden': 'true',
                      className: 'flex mx-1 text-current self-center',
                      fill: 'none',
                      height: '1em',
                      shapeRendering: 'geometricPrecision',
                      stroke: 'currentColor',
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                      strokeWidth: '1.5',
                      viewBox: '0 0 24 24',
                      width: '1em'
                    },
                    children: [
                      {
                        type: 'element',
                        tagName: 'path',
                        properties: {
                          d: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6'
                        },
                        children: []
                      },
                      {
                        type: 'element',
                        tagName: 'path',
                        properties: { d: 'M15 3h6v6' },
                        children: []
                      },
                      {
                        type: 'element',
                        tagName: 'path',
                        properties: { d: 'M10 14L21 3' },
                        children: []
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    })
  }
}
