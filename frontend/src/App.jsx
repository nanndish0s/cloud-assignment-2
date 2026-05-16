import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Plane, Luggage, User, CheckCircle, Bell, Lock, Mail, Shield, Search, RefreshCw, Pencil, Trash2, X } from 'lucide-react';

const API_BASE = 'http://localhost:3000';

const decodeToken = (token) => {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch {
    return null;
  }
};

const BAGGAGE_STATUSES = ['REGISTERED', 'IN-TRANSIT', 'DELIVERED'];

const statusColor = (status) => {
  if (status === 'DELIVERED') return 'text-green-400';
  if (status === 'IN-TRANSIT') return 'text-yellow-400';
  return 'text-blue-400';
};

function App() {
  const [flights, setFlights] = useState([]);
  const [bookingStatus, setBookingStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  // Auth
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [authMode, setAuthMode] = useState('login');
  const [userRole, setUserRole] = useState('');

  // Baggage tracker
  const [baggage, setBaggage] = useState(null);
  const [baggageIdInput, setBaggageIdInput] = useState('');
  const [baggageError, setBaggageError] = useState('');
  const [newStatus, setNewStatus] = useState('');
  const [statusUpdateMsg, setStatusUpdateMsg] = useState('');

  // Admin panel — update availability
  const [adminFlightId, setAdminFlightId] = useState('');
  const [adminSeats, setAdminSeats] = useState('');
  const [adminMsg, setAdminMsg] = useState('');

  // Admin panel — create flight
  const [newFlight, setNewFlight] = useState({ id: '', origin: '', destination: '', seats: '', price: '' });
  const [createFlightMsg, setCreateFlightMsg] = useState('');

  // Admin panel — edit flight
  const [editingFlight, setEditingFlight] = useState(null);

  useEffect(() => {
    if (token) {
      const decoded = decodeToken(token);
      setUserRole(decoded?.role || 'user');
      setIsLoggedIn(true);
      fetchFlights();
    }
  }, [token]);

  const fetchFlights = async () => {
    try {
      const res = await axios.get(`${API_BASE}/flights`);
      setFlights(res.data);
    } catch {
      console.error('Failed to fetch flights');
    }
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register';
      const res = await axios.post(`${API_BASE}${endpoint}`, { email, password });

      if (authMode === 'login') {
        const newToken = res.data.token;
        const decoded = decodeToken(newToken);
        setToken(newToken);
        setUserRole(decoded?.role || 'user');
        localStorage.setItem('token', newToken);
        setIsLoggedIn(true);
        fetchFlights();
      } else {
        alert('Registration successful! Please login.');
        setAuthMode('login');
      }
    } catch (error) {
      alert(error.response?.data?.error || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setToken('');
    setUserRole('');
    localStorage.removeItem('token');
    setIsLoggedIn(false);
    setFlights([]);
    setBaggage(null);
  };

  const handleBooking = async (flightId) => {
    setLoading(true);
    try {
      const res = await axios.post(
        `${API_BASE}/bookings`,
        { flightId, passengerEmail: email },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const bid = res.data.bookingId;
      setBookingStatus(`Flight ${flightId} booked! Booking ID: ${bid}`);
      setBaggageIdInput(`BAG-${bid}`);
      setTimeout(() => fetchBaggageById(`BAG-${bid}`), 2000);
      setTimeout(() => setBookingStatus(null), 6000);
      fetchFlights();
    } catch (error) {
      alert(error.response?.data?.error || 'Booking failed');
    } finally {
      setLoading(false);
    }
  };

  const fetchBaggageById = async (id) => {
    const lookupId = id || baggageIdInput.trim();
    if (!lookupId) return;
    setBaggageError('');
    try {
      const res = await axios.get(`${API_BASE}/baggage/${lookupId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setBaggage(res.data);
      setNewStatus(res.data.Status);
    } catch {
      setBaggage(null);
      setBaggageError('Baggage record not found.');
    }
  };

  const handleStatusUpdate = async () => {
    if (!baggage || !newStatus) return;
    try {
      await axios.patch(
        `${API_BASE}/baggage/${baggage.BaggageId}/status`,
        { status: newStatus },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setStatusUpdateMsg(`Status updated to ${newStatus}`);
      fetchBaggageById(baggage.BaggageId);
      setTimeout(() => setStatusUpdateMsg(''), 4000);
    } catch (error) {
      setStatusUpdateMsg(error.response?.data?.error || 'Update failed');
    }
  };

  const handleAdminUpdate = async (e) => {
    e.preventDefault();
    setAdminMsg('');
    try {
      await axios.patch(
        `${API_BASE}/flights/${adminFlightId}/availability`,
        { seats: parseInt(adminSeats) },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setAdminMsg(`Flight ${adminFlightId} updated to ${adminSeats} seats.`);
      fetchFlights();
      setAdminFlightId('');
      setAdminSeats('');
    } catch (error) {
      setAdminMsg(error.response?.data?.error || 'Update failed');
    }
  };

  const handleEditFlight = async (e) => {
    e.preventDefault();
    try {
      await axios.put(
        `${API_BASE}/flights/${editingFlight.id}`,
        {
          origin: editingFlight.origin,
          destination: editingFlight.destination,
          seats: parseInt(editingFlight.seats),
          price: editingFlight.price,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setEditingFlight(null);
      fetchFlights();
    } catch (error) {
      alert(error.response?.data?.error || 'Update failed');
    }
  };

  const handleDeleteFlight = async (flightId) => {
    if (!window.confirm(`Delete flight ${flightId}? This cannot be undone.`)) return;
    try {
      await axios.delete(`${API_BASE}/flights/${flightId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      fetchFlights();
    } catch (error) {
      alert(error.response?.data?.error || 'Delete failed');
    }
  };

  const handleCreateFlight = async (e) => {
    e.preventDefault();
    setCreateFlightMsg('');
    try {
      await axios.post(
        `${API_BASE}/flights`,
        { ...newFlight, seats: parseInt(newFlight.seats) },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setCreateFlightMsg(`Flight ${newFlight.id.toUpperCase()} created successfully.`);
      setNewFlight({ id: '', origin: '', destination: '', seats: '', price: '' });
      fetchFlights();
    } catch (error) {
      setCreateFlightMsg(error.response?.data?.error || 'Create failed');
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
        <div className="glass p-8 w-full max-w-md">
          <div className="flex flex-col items-center mb-8">
            <Plane className="w-12 h-12 text-primary-400 mb-2" />
            <h1 className="text-2xl font-bold text-white">AeroLink Platform</h1>
            <p className="text-slate-400 text-sm mt-1">Cloud-Native Airline Systems</p>
          </div>
          <form onSubmit={handleAuth} className="space-y-4">
            <div className="relative">
              <Mail className="absolute left-3 top-3 w-5 h-5 text-slate-500" />
              <input type="email" placeholder="Email Address" required
                className="w-full bg-white/5 border border-white/10 rounded-lg py-2.5 pl-10 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-3 w-5 h-5 text-slate-500" />
              <input type="password" placeholder="Password" required
                className="w-full bg-white/5 border border-white/10 rounded-lg py-2.5 pl-10 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <button type="submit" disabled={loading} className="w-full btn-primary py-3">
              {loading ? 'Processing...' : authMode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
          <div className="mt-6 text-center text-sm text-slate-400">
            {authMode === 'login'
              ? <p>No account? <button onClick={() => setAuthMode('register')} className="text-primary-400 hover:underline">Register here</button></p>
              : <p>Have an account? <button onClick={() => setAuthMode('login')} className="text-primary-400 hover:underline">Login here</button></p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">

      {/* Header */}
      <header className="flex justify-between items-center mb-10">
        <div className="flex items-center gap-3">
          <Plane className="w-10 h-10 text-primary-400" />
          <h1 className="text-3xl font-bold text-white">AeroLink <span className="text-primary-500">Systems</span></h1>
        </div>
        <div className="flex items-center gap-3 glass px-4 py-2">
          <User className="w-5 h-5 text-primary-400" />
          <span className="text-sm text-white">{email}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold uppercase ${userRole === 'admin' ? 'bg-red-500/30 text-red-300' : userRole === 'gate-agent' ? 'bg-yellow-500/30 text-yellow-300' : 'bg-blue-500/30 text-blue-300'}`}>
            {userRole}
          </span>
          <button onClick={handleLogout} className="ml-2 text-xs text-red-400 hover:text-red-300">Logout</button>
        </div>
      </header>

      {/* Booking success banner */}
      {bookingStatus && (
        <div className="mb-8 p-4 bg-green-500/20 border border-green-500/50 rounded-lg flex items-center gap-3 text-green-300">
          <CheckCircle className="w-5 h-5 shrink-0" />
          {bookingStatus}
        </div>
      )}

      <main className="grid grid-cols-1 lg:grid-cols-3 gap-8">

        {/* LEFT — Flights */}
        <div className="lg:col-span-2 space-y-6">
          <h2 className="text-xl font-semibold text-slate-300 flex items-center gap-2">
            <Plane className="w-5 h-5" /> Available Flights
          </h2>
          <div className="grid gap-4">
            {flights.map(flight => (
              <div key={flight.id} className="glass p-6 hover:bg-white/15 transition-all">
                {editingFlight?.id === flight.id ? (
                  // Inline edit form
                  <form onSubmit={handleEditFlight} className="space-y-3">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm font-mono text-slate-400">{flight.id}</span>
                      <button type="button" onClick={() => setEditingFlight(null)} className="text-slate-500 hover:text-white">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input type="text" placeholder="Origin" required
                        className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        value={editingFlight.origin} onChange={(e) => setEditingFlight({ ...editingFlight, origin: e.target.value })} />
                      <input type="text" placeholder="Destination" required
                        className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        value={editingFlight.destination} onChange={(e) => setEditingFlight({ ...editingFlight, destination: e.target.value })} />
                      <input type="number" placeholder="Seats" min="0" required
                        className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        value={editingFlight.seats} onChange={(e) => setEditingFlight({ ...editingFlight, seats: e.target.value })} />
                      <input type="text" placeholder="Price" required
                        className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        value={editingFlight.price} onChange={(e) => setEditingFlight({ ...editingFlight, price: e.target.value })} />
                    </div>
                    <button type="submit" className="w-full btn-primary py-2 text-sm">Save Changes</button>
                  </form>
                ) : (
                  // Normal display
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="text-2xl font-bold text-white mb-1">{flight.origin} → {flight.destination}</div>
                      <div className="text-sm text-slate-400 font-mono">{flight.id}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold text-primary-400 mb-1">{flight.price}</div>
                      <div className={`text-sm mb-3 ${flight.seats === 0 ? 'text-red-400' : 'text-slate-400'}`}>
                        {flight.seats === 0 ? 'Fully booked' : `${flight.seats} seats remaining`}
                      </div>
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => handleBooking(flight.id)} disabled={loading || flight.seats === 0}
                          className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
                          {loading ? 'Booking...' : 'Book Now'}
                        </button>
                        {userRole === 'admin' && (
                          <>
                            <button onClick={() => setEditingFlight({ ...flight })}
                              className="p-2 bg-white/10 hover:bg-white/20 rounded-lg text-slate-300 transition-all" title="Edit flight">
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleDeleteFlight(flight.id)}
                              className="p-2 bg-red-500/20 hover:bg-red-500/30 rounded-lg text-red-400 transition-all" title="Delete flight">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT — Sidebar */}
        <div className="space-y-6">

          {/* Baggage Tracker */}
          <section className="glass p-6">
            <h3 className="text-lg font-semibold text-slate-200 mb-4 flex items-center gap-2">
              <Luggage className="w-5 h-5 text-primary-400" /> Baggage Tracker
            </h3>

            <div className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder="BAG-BK-1234"
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={baggageIdInput}
                onChange={(e) => setBaggageIdInput(e.target.value)}
              />
              <button onClick={() => fetchBaggageById()} className="btn-primary px-3 py-2">
                <Search className="w-4 h-4" />
              </button>
            </div>

            {baggageError && <p className="text-red-400 text-xs mb-3">{baggageError}</p>}

            {baggage ? (
              <div className="space-y-3">
                <div className="p-3 bg-white/5 rounded-lg">
                  <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Baggage ID</div>
                  <div className="text-sm text-white font-mono">{baggage.BaggageId}</div>
                </div>
                <div className="p-3 bg-white/5 rounded-lg">
                  <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Status</div>
                  <div className={`text-sm font-bold ${statusColor(baggage.Status)}`}>{baggage.Status}</div>
                </div>
                <div className="p-3 bg-white/5 rounded-lg">
                  <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Last Update</div>
                  <div className="text-sm text-slate-300">{new Date(baggage.LastUpdate).toLocaleString()}</div>
                </div>

                {/* Status update — available to all authenticated users (gate agents use this) */}
                <div className="pt-2 border-t border-white/10">
                  <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Update Status</div>
                  <div className="flex gap-2">
                    <select
                      className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
                      value={newStatus}
                      onChange={(e) => setNewStatus(e.target.value)}
                    >
                      {BAGGAGE_STATUSES.map(s => <option key={s} value={s} className="bg-slate-800">{s}</option>)}
                    </select>
                    <button onClick={handleStatusUpdate} className="btn-primary px-3 py-2">
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  </div>
                  {statusUpdateMsg && <p className="text-green-400 text-xs mt-2">{statusUpdateMsg}</p>}
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">Enter a Baggage ID to track, or book a flight to generate one automatically.</p>
            )}
          </section>

          {/* Admin Panel — only visible to admins */}
          {userRole === 'admin' && (
            <section className="glass p-6 border border-red-500/20 space-y-6">
              <h3 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
                <Shield className="w-5 h-5 text-red-400" /> Admin — Flight Operations
              </h3>

              {/* Create new flight */}
              <div>
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-3">Create New Flight</p>
                <form onSubmit={handleCreateFlight} className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <input type="text" placeholder="Flight ID (e.g. AL404)" required
                      className="col-span-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                      value={newFlight.id} onChange={(e) => setNewFlight({ ...newFlight, id: e.target.value })} />
                    <input type="text" placeholder="Origin" required
                      className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                      value={newFlight.origin} onChange={(e) => setNewFlight({ ...newFlight, origin: e.target.value })} />
                    <input type="text" placeholder="Destination" required
                      className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                      value={newFlight.destination} onChange={(e) => setNewFlight({ ...newFlight, destination: e.target.value })} />
                    <input type="number" placeholder="Seats" min="1" required
                      className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                      value={newFlight.seats} onChange={(e) => setNewFlight({ ...newFlight, seats: e.target.value })} />
                    <input type="text" placeholder="Price (e.g. LKR 200,000)" required
                      className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                      value={newFlight.price} onChange={(e) => setNewFlight({ ...newFlight, price: e.target.value })} />
                  </div>
                  <button type="submit" className="w-full py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-300 rounded-lg text-sm font-medium transition-all">
                    Create Flight
                  </button>
                  {createFlightMsg && <p className="text-xs text-green-400">{createFlightMsg}</p>}
                </form>
              </div>

              {/* Update seat availability */}
              <div>
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-3">Update Seat Availability</p>
                <form onSubmit={handleAdminUpdate} className="space-y-2">
                  <input type="text" placeholder="Flight ID (e.g. AL101)" required
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                    value={adminFlightId} onChange={(e) => setAdminFlightId(e.target.value)} />
                  <input type="number" placeholder="New seat count" min="0" required
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                    value={adminSeats} onChange={(e) => setAdminSeats(e.target.value)} />
                  <button type="submit" className="w-full py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-300 rounded-lg text-sm font-medium transition-all">
                    Update Availability
                  </button>
                  {adminMsg && <p className="text-xs text-green-400">{adminMsg}</p>}
                </form>
              </div>
            </section>
          )}

          {/* System Status */}
          <section className="glass p-6">
            <h3 className="text-lg font-semibold text-slate-200 mb-4 flex items-center gap-2">
              <Bell className="w-5 h-5 text-primary-400" /> System Status
            </h3>
            <div className="space-y-2 text-xs text-slate-400">
              <div className="flex justify-between"><span>API Gateway</span><span className="text-green-400">ONLINE</span></div>
              <div className="flex justify-between"><span>Auth Service (JWT/bcrypt)</span><span className="text-green-400">READY</span></div>
              <div className="flex justify-between"><span>Kafka Event Bus</span><span className="text-green-400">ACTIVE</span></div>
              <div className="flex justify-between"><span>DynamoDB (Baggage)</span><span className="text-green-400">CONNECTED</span></div>
            </div>
          </section>

        </div>
      </main>
    </div>
  );
}

export default App;
