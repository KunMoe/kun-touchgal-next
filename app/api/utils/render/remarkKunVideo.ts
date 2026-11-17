import { visit } from 'unist-util-visit'
import { readKunDirective } from '~/utils/markdown/kunDialect'
import type { Plugin } from 'unified'
import type { Node } from 'unist'

export const remarkKunVideo: Plugin<[], Node> = () => {
  return (tree) => {
    visit(tree, (node: any) => {
      const attrs = readKunDirective(node, 'kun-video')
      if (attrs) {
        const { src } = attrs
        const data = node.data

        data.hName = 'div'
        data.hProperties = {
          'data-video-player': '',
          'data-src': src,
          role: 'button',
          tabIndex: 0,
          'aria-label': '加载视频播放器',
          className:
            'group relative w-full my-4 aspect-video cursor-pointer overflow-hidden rounded-xl bg-black text-white shadow-lg'
        }
        data.hChildren = [
          {
            type: 'element',
            tagName: 'div',
            properties: { className: 'absolute inset-0 bg-black' },
            children: []
          },
          {
            type: 'element',
            tagName: 'div',
            properties: {
              className: 'absolute inset-0 flex items-center justify-center'
            },
            children: [
              {
                type: 'element',
                tagName: 'div',
                properties: {
                  className:
                    'flex h-12 w-12 items-center justify-center rounded-full bg-[#00b3ff] shadow-lg transition-transform group-hover:scale-105'
                },
                children: [
                  {
                    type: 'element',
                    tagName: 'svg',
                    properties: {
                      'aria-hidden': 'true',
                      className: 'relative left-0.5 text-white',
                      fill: 'currentColor',
                      height: 18,
                      viewBox: '0 0 18 18',
                      width: 18
                    },
                    children: [
                      {
                        type: 'element',
                        tagName: 'path',
                        properties: {
                          d: 'M15.562 8.1L3.87.225c-.818-.562-1.87 0-1.87.9v15.75c0 .9 1.052 1.462 1.87.9L15.563 9.9c.584-.45.584-1.35 0-1.8z'
                        },
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
