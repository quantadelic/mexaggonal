
const WebSocketClient   = require('./WebsocketClient');
const EventEmitter      = require('./EventEmitter');

const LATENCY_SMOOTH = 5;

class Aggregate extends EventEmitter
{
    constructor( opts )
    {
        super();

        this.wsc = new WebSocketClient();

        this.resolution = opts.resolution;
        this.topic = opts.topic;
        this.service = opts.url;

        this.data = [];
        this.latencies = [], this._avglatency = 0;
        this.timer = null;

        this.initialized = false;
             
    }

    start() {

        this.wsc.open( this.service );

        this.wsc.onopen = ( e ) => { 
            this.emit('connected');
            this.wsc.send( this.topic );
        }

        this.wsc.onmessage = ( data, flags, number ) => {

            let frame = JSON.parse( data );
        
            // ignore any weirdo crap
            if ( !frame || !frame.table || !frame.data || !frame.action || !frame.action=='insert' || 
                 !frame.table == 'trade' || !Array.isArray( frame.data ) || !frame.data.length )
                return;
        
            for ( let d of frame.data )
            {
                if ( !d.price || !d.timestamp || !d.size ) continue;
        
                this.add( d.timestamp, d.price, d.size );
    
            }
        
        }   

    }


    add( time, price, size ) {
        let timestamp = Date.parse( time );

        this.data.push({ timestamp, price, size });
            
        this._check_boundary();

    }

    get latency() { return this._avglatency }

    // Produce smoothed average of the last N latency figures
    _average_latency( latency ) {
        
        // Ignore huge latency, bitmex pushes old timestamps on initialisation
        
        if ( latency > 1000 ) return 0;

        this.latencies.push( latency );
        this.latencies = this.latencies.slice( -LATENCY_SMOOTH );
        this._avglatency = Math.round( this.latencies.reduce((a,b) => a + b, 0) / this.latencies.length );
        return this._avglatency;
    }

    _last() {
        return this.data.length ? this.data[ this.data.length - 1 ] : null;
    }

    _check_boundary( )
    {
        if ( !this.data.length ) 
            return;

        let l = this._last();

        // Assuming your system clock is correct, asshole
        let n = Date.now();                     

        // Roughly, how long is it taking to receive data from BitMEX's servers 
        let averagelatency = this._average_latency( n - l.timestamp );

        // How far into the bar are we in relative ms
        let offset = l.timestamp % this.resolution;

        // What is the actual open time of this proposed new bar
        let mark = l.timestamp - offset;

        // console.log( (new Date(l.timestamp)).toISOString(),  (new Date(mark)).toISOString(), l.price, l.size, `latency: ${averagelatency}ms`);

        // Disable the previous timer, we've got a new timestamp to offset from
        if ( this.timer )
            clearTimeout( this.timer );

        // Calculate how much time remains for this bar 
        let remaining = ( this.resolution - offset ) + averagelatency;
        
        // Set a timer, including BitMEX server latency, so we can aggregate and emit asap
        this.timer = setTimeout( (this._aggregate).bind(this), remaining, mark );
    }

    _aggregate( opentime ) {

        // Ignore first bar
        if ( !this.initialized ) {
            this.initialized = true;
            this.emit('initialized');
            return;
        }

        // Exact :00.000 miliseconds start of next bar
        let nextopentime = opentime + this.resolution;

        // Get all price changes occuring within this bar's time period
        let changes = this.data.filter( d => d.timestamp >= opentime && d.timestamp < nextopentime );

        // Get the first price nearest the open time
        let firstindex = this.data.findIndex( d => d.timestamp >= opentime );

        let i = firstindex;
                                                                
        if ( this.data[ i ].timestamp != opentime && i > 0 )    // If the first price doesn't match the open time *exactly* 
            i--;                                                // (most cases!) then use the previous price if available...
        else                                                    // 
            return;                                             // ...otherwise return as we can't be 100% sure what the true open price is
        
        // Get prices, strip timestamps to use spread operator
        let prices = changes.map( c => c.price );
            
        let open = this.data[ i ].price;                        // `i` in most cases is the final price of previous bar (close)
        let high = Math.max( ...prices );
        let low = Math.min( ...prices );
        let close = changes[ changes.length - 1 ].price;        // last price received before exact start of next bar
        let volume = changes.reduce( (a,b) => a + b.size, 0 );

                
        this.emit('bar', { timestamp: (new Date(opentime)).toISOString(), epoch: opentime, open, high, low, close, volume });

        // Finally; limit memory usage. Take all of the next bar data including previous bar's last price ( -1 )
        this.data = this.data.slice ( this.data.findIndex( d => d.timestamp >= nextopentime ) - 1 );
                
    }

}


module.exports = Aggregate;