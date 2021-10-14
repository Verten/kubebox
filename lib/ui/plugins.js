'use strict';
const EventEmitter = require('events');
const { focus: { focusIndicator }, setLabel, spinner: { until } } = require('./ui');
const { scroll, throttle } = require('./blessed/scroll');
const blessed = require("blessed");
const {SelectEvent, AddEvent} = require("./navbar");
const Dialog = require('./dialog')
const fs = require('fs')
const path = require("path");
const os = require("os");

class Plugins extends EventEmitter{
    pluginsTable = null
    _pluginList = []
    _selectedPlugin = null

    constructor({ screen, navbar, status, client }) {
        super();
        const plugins = this;
        this.pluginsTable = this.initPluginsTable(screen)

        this.fetchPluginList()
        this.handlePluginTableSelectEvent(screen)

        this.on(SelectEvent, ({ screen }) => {
            screen.append(this.pluginsTable);
            this.initPluginsTableData(this.pluginList)
            screen.render();
        });

        this.on(AddEvent, ({ page }) => {
            page.focus = this.pluginsTable;
        });
    }

    set selectedPlugin(p) {
        this._selectedPlugin = p
        // after set selected plugin we need update plugin table
        this.initPluginsTableData(this.pluginList)
    }

    get selectedPlugin() {
        return this._selectedPlugin
    }

    set pluginList(l){
        this._pluginList = l
        // after we update plugin list we also need update plugin table
        this.initPluginsTableData(this.pluginList)
    }

    get pluginList() {
        return this._pluginList
    }

    initPluginsTable = (screen) => {
        return blessed.with(focusIndicator, scroll, throttle).listtable({
            label: 'Plugins',
            left: 0,
            top: 1,
            width: '100%',
            height: '100%-1',
            border: 'line',
            align: 'left',
            keys: true,
            tags: true,
            mouse: true,
            noCellBorders: true,
            invertSelected: false,
            scrollbar: {
                ch: ' ',
                style: {bg: 'white'},
                track: {
                    style: {bg: 'grey'},
                },
            },
            style: {
                label: {bold: true},
                header: {fg: 'grey'},
                cell: {selected: {bold: true, fg: 'black', bg: 'white'}},
            },
        })
    }

    fetchPluginList = () => {
        this.pluginList = [
            {
                id: '1',
                name: 'termshark',
                status: 'uninstall',
            },
            {
                id: '2',
                name: 'Plugin-2',
                status: 'uninstall',
            },
            {
                id: '3',
                name: 'Plugin-3',
                status: 'uninstall',
            },
            {
                id: '4',
                name: 'Plugin-4',
                status: 'uninstall',
            },
            {
                id: '5',
                name: 'Plugin-5',
                status: 'uninstall',
            },
        ]
    }

    initPluginsTableData = (pluginData) => {
        const { selected, childBase, childOffset } = this.pluginsTable;
        const selectedRow = this.pluginsTable.rows[selected];

        this.pluginsTable.setData((pluginData||[]).reduce((rows, plugin) => {
            let row = [
                plugin.id, plugin.name, plugin.status
            ]
            // highlight selected row
            if(this.selectedPlugin !== null && this.selectedPlugin.id === plugin.id){
                row = row.map(c => `{blue-fg}${c}{/blue-fg}`)
            }
            row.id = plugin.id
            rows.push(row)
            return rows
        }, [["ID", "NAME", "STATUS"]]))

        // restore selection and scrolling
        if (selectedRow) {
            const index = this.pluginsTable.rows.slice(1).findIndex(r => r.id === selectedRow.id) + 1;
            this.pluginsTable.select(index);
            Object.assign(this.pluginsTable, { childBase: childBase + (index - selected), childOffset });
            this.pluginsTable.scrollTo(index);
        }
    }

    handlePluginTableSelectEvent = (screen) => {
        this.pluginsTable.on('select', (item, i) => {
            if (i === 0) return;
            // update selected plugin
            this.selectedPlugin = this.pluginList[i - 1]
            if(i === 1 && this.selectedPlugin.status !== 'installed'){
                this.pluginList = this.pluginList.map((l, index) => {
                    if (index === i - 1) {
                        return {
                            ...l,
                            status: 'installed'
                        }
                    } else {
                        return l
                    }
                })
                // load url from config
                const configString = fs.readFileSync(path.join('.config'), 'utf8')
                console.info(configString)
                const config = JSON.parse(configString)
                Dialog.prompt(screen, config.accessUrl)
            }
        })
    }
}

module.exports = Plugins
